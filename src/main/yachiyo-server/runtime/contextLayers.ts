import type {
  MessageFileAttachment,
  MessageImageRecord,
  MessageTurnContext
} from '../../../shared/yachiyo/protocol.ts'
import {
  extractBase64DataUrlPayload,
  normalizeMessageImages
} from '../../../shared/yachiyo/messageContent.ts'
import type { ModelMessage } from './types.ts'
import type { SkillSummary } from '../../../shared/yachiyo/protocol.ts'

export interface ContextLayerHistoryMessage {
  role: 'user' | 'assistant'
  content: string
  images?: MessageImageRecord[]
  attachments?: MessageFileAttachment[]
  /** Structured AI SDK response messages from tool-using runs, used for lossless history replay. */
  responseMessages?: unknown[]
  /**
   * Per-turn context (reminder + recalled memory entries) that was originally
   * appended to this user message when its turn ran. Replayed inline so older
   * turns retain their temporal context (timestamps, memory snapshots) and the
   * model has full continuity across multi-turn runs. The current turn's
   * request message must omit this field — the live `hint`/`memory` inputs
   * will append the fresh per-turn block to the last user message instead.
   */
  turnContext?: MessageTurnContext
}

export interface PersonalityLayerInput {
  basePersona: string
}

export interface SoulLayerInput {
  content?: string
}

export interface AgentLayerInput {
  instructions?: string
}

export interface UserLayerInput {
  content?: string
}

export interface SkillsLayerInput {
  activeSkills?: SkillSummary[]
}

export interface HintLayerInput {
  reminder?: string
}

export interface MemoryLayerInput {
  entries?: string[]
}

export interface CompileContextLayersInput {
  history: ContextLayerHistoryMessage[]
  personality: PersonalityLayerInput
  soul?: SoulLayerInput
  user?: UserLayerInput
  skills?: SkillsLayerInput
  agent?: AgentLayerInput
  hint?: HintLayerInput
  memory?: MemoryLayerInput
  /** When true, mark the last system message with an Anthropic cache breakpoint. */
  anthropicCacheBreakpoints?: boolean
}

function removeEmptyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => {
    if (typeof message.content === 'string') {
      return message.content.trim().length > 0
    }

    return message.content.length > 0
  })
}

function buildAttachedFilesBlock(
  images: MessageImageRecord[] | undefined,
  attachments: MessageFileAttachment[] | undefined
): string | null {
  const imageEntries = (images ?? [])
    .filter((img) => img.workspacePath)
    .map((img) => {
      const header = `- ${img.filename ?? 'image'} (${img.mediaType}) → ${img.workspacePath}`
      if (img.altText && !img.dataUrl) {
        return `${header}\n  Description: ${img.altText}`
      }
      return `${header} [sent inline]`
    })

  const fileEntries = (attachments ?? []).map(
    (a) => `- ${a.filename} (${a.mediaType}) → ${a.workspacePath}`
  )

  const allEntries = [...imageEntries, ...fileEntries]
  if (allEntries.length === 0) {
    return null
  }

  return ['<attached_files>', ...allEntries, '</attached_files>'].join('\n')
}

/**
 * Remove image-data content blocks from tool result messages before history replay.
 * The original image turn already included a text reference block alongside the image,
 * so the model retains the path context while base64 blobs are not re-injected.
 */
function stripImageDataFromResponseMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg): ModelMessage => {
    if (msg.role !== 'tool') return msg
    const filtered = msg.content.map((part) => {
      if (part.type !== 'tool-result') return part
      const output = part.output as { type?: string; value?: unknown[] } | undefined
      if (output?.type !== 'content' || !Array.isArray(output.value)) return part
      const hasInlineMedia = output.value.some(
        (block) => (block as { type: string }).type === 'image-data'
      )
      if (!hasInlineMedia) return part
      const filteredValue = output.value.map((block): unknown => {
        if ((block as { type: string }).type !== 'image-data') return block
        const b = block as { type: string; mediaType: string }
        return {
          type: 'text',
          text: `[Image (${b.mediaType}) was shown in this turn and is not re-sent to keep context lean.]`
        }
      })
      return { ...part, output: { ...output, value: filteredValue } as typeof part.output }
    })
    return { ...msg, content: filtered }
  })
}

/**
 * Ensure reasoning blocks in replayed responseMessages carry a provider
 * signature so the Anthropic adapter doesn't silently drop them. Non-Anthropic
 * providers (e.g. Kimi) emit reasoning without signatures; we inject a
 * synthetic one so the content survives across turns.
 *
 * We skip injection when the block already has an Anthropic signature in
 * providerOptions or metadata from any non-Anthropic provider (OpenAI, Google,
 * etc.) so we don't pile provider-specific metadata on top of each other.
 *
 * If the signature only lives in providerMetadata (as the AI SDK stores it
 * after an Anthropic response), we copy it into providerOptions because the
 * Anthropic adapter reads from providerOptions when building the prompt.
 */
function patchReasoningSignatures(messages: ModelMessage[]): ModelMessage[] {
  let patched = false
  const result = messages.map((msg): ModelMessage => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg

    let contentPatched = false
    const content = (msg.content as Array<Record<string, unknown>>).map((part) => {
      if (part.type !== 'reasoning') return part

      const providerOptions = part.providerOptions as Record<string, unknown> | undefined
      const providerMetadata = part.providerMetadata as Record<string, unknown> | undefined

      const anthropicOptions = providerOptions?.anthropic as Record<string, unknown> | undefined
      const anthropicMetadata = providerMetadata?.anthropic as Record<string, unknown> | undefined

      // Already has the signature where the adapter looks — nothing to do.
      if (anthropicOptions?.signature) return part

      // Signature only lives in providerMetadata — copy it to providerOptions
      // so the Anthropic adapter can find it on the next request.
      if (anthropicMetadata?.signature) {
        contentPatched = true
        return {
          ...part,
          providerOptions: {
            ...providerOptions,
            anthropic: { ...anthropicOptions, signature: anthropicMetadata.signature }
          }
        }
      }

      // Skip injection for any non-Anthropic provider metadata.
      const nonAnthropicEntries = [
        ...Object.entries(providerOptions ?? {}).filter(([key]) => key !== 'anthropic'),
        ...Object.entries(providerMetadata ?? {}).filter(([key]) => key !== 'anthropic')
      ]
      const hasNonAnthropicMeta = nonAnthropicEntries.some(
        ([, value]) => value != null && typeof value === 'object' && Object.keys(value).length > 0
      )
      if (hasNonAnthropicMeta) return part

      // Bare reasoning block — inject synthetic signature for Anthropic compatibility.
      contentPatched = true
      const syntheticMeta = {
        ...(anthropicOptions as Record<string, unknown> | undefined),
        ...(anthropicMetadata as Record<string, unknown> | undefined),
        signature: 'yachiyo-passthrough'
      }
      return {
        ...part,
        providerOptions: { ...providerOptions, anthropic: syntheticMeta },
        providerMetadata: { ...providerMetadata, anthropic: syntheticMeta }
      }
    })

    if (!contentPatched) return msg
    patched = true
    return { ...msg, content } as ModelMessage
  })

  return patched ? result : messages
}

/**
 * Build the per-turn-context parts for a historical user message — the same
 * shape that `compileContextLayers` would build via `compileHintLayer` and
 * `compileMemoryLayer`. Returned as an array of strings so the caller can
 * decide whether to fold them into a single text body (string-content path)
 * or emit them as separate text parts after image blocks (multimodal path),
 * mirroring `appendTurnContextToUserMessage` exactly for byte-stable replay.
 */
function buildHistoricalTurnContextParts(turnContext: MessageTurnContext | undefined): string[] {
  if (!turnContext) return []
  const parts: string[] = []
  const hintMessage = compileHintLayer({ reminder: turnContext.reminder })
  if (hintMessage && typeof hintMessage.content === 'string') {
    parts.push(hintMessage.content)
  }
  const memoryMessage = compileMemoryLayer({ entries: turnContext.memoryEntries })
  if (memoryMessage && typeof memoryMessage.content === 'string') {
    parts.push(memoryMessage.content)
  }
  return parts
}

export async function preprocessImagesForNonVisionModel(
  history: ContextLayerHistoryMessage[],
  imageToTextService: {
    describe(dataUrl: string, caption?: string): Promise<{ altText: string } | null>
  }
): Promise<ContextLayerHistoryMessage[]> {
  return Promise.all(
    history.map(async (msg) => {
      if (msg.role !== 'user' || !msg.images?.length) return msg
      const processed = await Promise.all(
        msg.images.map(async (img) => {
          if (img.altText) return { ...img, dataUrl: '' }
          if (!img.dataUrl) return img
          const result = await imageToTextService.describe(img.dataUrl, '')
          if (!result) return { ...img, dataUrl: '' }
          return { ...img, altText: result.altText, dataUrl: '' }
        })
      )
      return { ...msg, images: processed }
    })
  )
}

export function toModelHistoryMessages(message: ContextLayerHistoryMessage): ModelMessage[] {
  if (message.role !== 'user') {
    if (message.responseMessages && message.responseMessages.length > 0) {
      return patchReasoningSignatures(
        stripImageDataFromResponseMessages(message.responseMessages as ModelMessage[])
      )
    }
    return [
      {
        role: message.role,
        content: message.content
      }
    ]
  }

  const describedImages = (message.images ?? []).filter((img) => !img.dataUrl && img.altText)
  const images = [...normalizeMessageImages(message.images), ...describedImages]
  const attachedFilesBlock = buildAttachedFilesBlock(message.images, message.attachments)
  const turnContextParts = buildHistoricalTurnContextParts(message.turnContext)
  const textContent = attachedFilesBlock
    ? `${message.content}\n\n${attachedFilesBlock}`
    : message.content

  if (images.length === 0) {
    // String-content path — match the live `appendTurnContextToUserMessage`
    // string branch which joins the original content with each turn-context
    // part using `\n\n`. Empty parts are skipped.
    const finalContent =
      turnContextParts.length > 0
        ? [textContent, ...turnContextParts].filter((part) => part.length > 0).join('\n\n')
        : textContent
    return [
      {
        role: 'user',
        content: finalContent
      }
    ]
  }

  // Multimodal path — match the live `appendTurnContextToUserMessage` array
  // branch which appends each turn-context part as a separate text block AFTER
  // the image/file blocks, preserving the original image/text pairing order.
  return [
    {
      role: 'user',
      content: [
        ...(textContent.trim().length > 0 ? [{ type: 'text' as const, text: textContent }] : []),
        ...images.flatMap(
          (
            image
          ): Array<
            { type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }
          > => {
            if (!image.dataUrl) {
              return image.altText ? [{ type: 'text', text: `[Image: ${image.altText}]` }] : []
            }
            return [
              {
                type: 'image',
                image: extractBase64DataUrlPayload(image.dataUrl)?.base64 ?? image.dataUrl,
                mediaType: image.mediaType
              }
            ]
          }
        ),
        ...turnContextParts.map((text) => ({ type: 'text' as const, text }))
      ]
    }
  ]
}

function normalizeLines(lines: string[] | undefined): string[] {
  return lines?.map((line) => line.trim()).filter(Boolean) ?? []
}

export function compilePersonalityLayer(input: PersonalityLayerInput): ModelMessage | null {
  const basePersona = input.basePersona.trim()
  if (!basePersona) {
    return null
  }

  return {
    role: 'system',
    content: basePersona
  }
}

export function compileSoulLayer(input: SoulLayerInput | undefined): ModelMessage | null {
  const content = input?.content?.trim() ?? ''
  if (!content) {
    return null
  }

  return {
    role: 'system',
    content: [
      'The following is your self-model and personality continuity record from SOUL.md. Absorb it holistically and integrate it naturally into your current persona:',
      '',
      content
    ].join('\n')
  }
}

export function compileAgentLayer(input: AgentLayerInput | undefined): ModelMessage | null {
  const instructions = input?.instructions?.trim() ?? ''
  if (!instructions) {
    return null
  }

  return {
    role: 'system',
    content: instructions
  }
}

export function compileUserLayer(input: UserLayerInput | undefined): ModelMessage | null {
  const content = input?.content?.trim() ?? ''
  if (!content) {
    return null
  }

  return {
    role: 'system',
    content: [
      'The following is your durable understanding of the user from USER.md. Treat it as a long-term collaboration profile, not as current task state:',
      '',
      content
    ].join('\n')
  }
}

export function compileSkillsLayer(input: SkillsLayerInput | undefined): ModelMessage | null {
  const activeSkills =
    input?.activeSkills
      ?.map((skill) => ({
        name: skill.name.trim(),
        description: skill.description?.trim() ?? ''
      }))
      .filter((skill) => skill.name.length > 0) ?? []

  if (activeSkills.length === 0) {
    return null
  }

  return {
    role: 'system',
    content: [
      'The following Skills are active for this run. You see names and descriptions only. To use a skill, first call skillsRead to get its exact SKILL.md path, then use the read tool on that exact path. Read SKILL.md before using the skill. If SKILL.md references other files and your work needs them, read those as well:',
      '',
      ...activeSkills.map((skill) =>
        skill.description ? `- ${skill.name}: ${skill.description}` : `- ${skill.name}`
      )
    ].join('\n')
  }
}

export function compileHintLayer(input: HintLayerInput | undefined): ModelMessage | null {
  const reminder = input?.reminder?.trim() ?? ''
  if (!reminder) {
    return null
  }

  return {
    role: 'system',
    content: reminder
  }
}

export function compileMemoryLayer(input: MemoryLayerInput | undefined): ModelMessage | null {
  const entries = normalizeLines(input?.entries)
  if (entries.length === 0) {
    return null
  }

  return {
    role: 'system',
    content: [
      '<memory>',
      "Background context from past conversations. Focus on the user's query first;",
      'overlapping terms do not make an entry relevant — judge by actual applicability.',
      ...entries.map((entry) => `- ${entry}`),
      '</memory>'
    ].join('\n')
  }
}

/**
 * Append turn-context text parts to a user message, preserving multimodal
 * content (images, files). When the original content is a string the parts
 * are joined with blank lines. When it is a structured array, new text
 * parts are appended so image/file blocks remain intact.
 */
export function appendTurnContextToUserMessage(
  message: ModelMessage,
  turnContextParts: string[]
): ModelMessage {
  const original = message.content
  if (typeof original === 'string') {
    return {
      role: 'user',
      content: [original, ...turnContextParts].join('\n\n')
    }
  }
  // Multimodal content — append text parts without disturbing image/file blocks.
  if (Array.isArray(original)) {
    const extraParts = turnContextParts.map((text) => ({ type: 'text' as const, text }))
    return {
      role: 'user',
      content: [...original, ...extraParts]
    } as ModelMessage
  }
  // Unexpected shape — fall back to standalone context.
  return { role: 'user', content: turnContextParts.join('\n\n') }
}

/**
 * Minimum number of messages between the system breakpoint and the
 * pre-last-user breakpoint before we insert a midpoint cache breakpoint.
 * Roughly 6 conversation turns — below this the extra breakpoint is
 * unlikely to pay for itself.
 */
const MIDPOINT_BREAKPOINT_MIN_GAP = 12

/** Merge an ephemeral cache-control marker into a message's providerOptions. */
function withCacheBreakpoint(message: ModelMessage): ModelMessage {
  const existing = message.providerOptions as Record<string, unknown> | undefined
  const existingAnthro = (existing?.anthropic ?? {}) as Record<string, unknown>
  return {
    ...message,
    providerOptions: {
      ...existing,
      anthropic: { ...existingAnthro, cacheControl: { type: 'ephemeral' as const } }
    }
  }
}

/**
 * Add Anthropic cache breakpoints to the compiled message array.
 *
 * Breakpoint 1: last system message — caches the stable system prefix.
 * Breakpoint 2: last message before the current (last) user message —
 *               caches system prefix + all prior conversation history.
 * Breakpoint 3 (conditional): midpoint of history when the gap between
 *               BP1 and BP2 exceeds MIDPOINT_BREAKPOINT_MIN_GAP, giving
 *               a fallback cache layer for branching / retry from older turns.
 *
 * Anthropic allows up to 4 breakpoints; we use 2–3 depending on
 * conversation length.
 */
function applyAnthropicCacheBreakpoints(messages: ModelMessage[]): void {
  // Breakpoint 1: last system message.
  let systemIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') {
      systemIdx = i
      messages[i] = withCacheBreakpoint(messages[i])
      break
    }
  }

  // Breakpoint 2: the message just before the last user message.
  // The last user message is volatile (has hint/memory appended), but
  // everything before it is stable and cacheable.
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  let bp2Idx = -1
  if (lastUserIdx > 0) {
    bp2Idx = lastUserIdx - 1
    messages[bp2Idx] = withCacheBreakpoint(messages[bp2Idx])
  }

  // Breakpoint 3 (conditional): midpoint between BP1 and BP2 for long
  // conversations. Placed on the nearest assistant message to the
  // arithmetic midpoint for a clean turn boundary.
  const rangeStart = systemIdx + 1
  const rangeEnd = bp2Idx >= 0 ? bp2Idx : lastUserIdx
  if (rangeEnd - rangeStart >= MIDPOINT_BREAKPOINT_MIN_GAP) {
    const mid = Math.floor((rangeStart + rangeEnd) / 2)
    // Scan outward from the midpoint to find the nearest assistant message.
    let best = -1
    for (let offset = 0; offset <= rangeEnd - rangeStart; offset++) {
      for (const dir of [mid + offset, mid - offset]) {
        if (dir > rangeStart && dir < rangeEnd && messages[dir].role === 'assistant') {
          best = dir
          break
        }
      }
      if (best >= 0) break
    }
    if (best >= 0) {
      messages[best] = withCacheBreakpoint(messages[best])
    }
  }
}

export function compileContextLayers(input: CompileContextLayersInput): ModelMessage[] {
  const systemParts = [
    compilePersonalityLayer(input.personality),
    compileSoulLayer(input.soul),
    compileUserLayer(input.user),
    compileSkillsLayer(input.skills),
    compileAgentLayer(input.agent)
  ]
    .flatMap((message) => (message ? [message.content as string] : []))
    .filter((part) => part.trim().length > 0)

  const systemLayers: ModelMessage[] =
    systemParts.length > 0 ? [{ role: 'system', content: systemParts.join('\n\n') }] : []

  const historyMessages = input.history.flatMap(toModelHistoryMessages)

  // Turn context (hint + memory) is merged into the last user message so the
  // user's query remains the final user turn. This avoids injected context
  // becoming the "latest user message" that the model responds to, while
  // keeping the message array prefix stable for prompt caching.
  const turnContextParts: string[] = [
    compileHintLayer(input.hint),
    compileMemoryLayer(input.memory)
  ].flatMap((message) => (message ? [message.content as string] : []))

  if (turnContextParts.length === 0) {
    const result = removeEmptyMessages([...systemLayers, ...historyMessages])
    if (input.anthropicCacheBreakpoints) applyAnthropicCacheBreakpoints(result)
    return result
  }

  const result = [...historyMessages]
  // Find the last user message and append turn context to it.
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      result[i] = appendTurnContextToUserMessage(result[i], turnContextParts)
      const final = removeEmptyMessages([...systemLayers, ...result])
      if (input.anthropicCacheBreakpoints) applyAnthropicCacheBreakpoints(final)
      return final
    }
  }

  // No user message in history — create a standalone turn context message.
  const final = removeEmptyMessages([
    ...systemLayers,
    ...result,
    { role: 'user', content: turnContextParts.join('\n\n') }
  ])
  if (input.anthropicCacheBreakpoints) applyAnthropicCacheBreakpoints(final)
  return final
}
