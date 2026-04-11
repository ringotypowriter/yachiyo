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
    .map(
      (img) =>
        `- ${img.filename ?? 'image'} (${img.mediaType}) → ${img.workspacePath} [sent inline]`
    )

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

export function toModelHistoryMessages(message: ContextLayerHistoryMessage): ModelMessage[] {
  if (message.role !== 'user') {
    if (message.responseMessages && message.responseMessages.length > 0) {
      return stripImageDataFromResponseMessages(message.responseMessages as ModelMessage[])
    }
    return [
      {
        role: message.role,
        content: message.content
      }
    ]
  }

  const images = normalizeMessageImages(message.images)
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
        ...images.map((image) => ({
          type: 'image' as const,
          image: extractBase64DataUrlPayload(image.dataUrl)?.base64 ?? image.dataUrl,
          mediaType: image.mediaType
        })),
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
      'The following Skills are active for this run. You see names and descriptions only; use skillsRead to fetch full SKILL.md content when needed:',
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
    content: ['<memory>', ...entries.map((entry) => `- ${entry}`), '</memory>'].join('\n')
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

export function compileContextLayers(input: CompileContextLayersInput): ModelMessage[] {
  const systemLayers = [
    compilePersonalityLayer(input.personality),
    compileSoulLayer(input.soul),
    compileUserLayer(input.user),
    compileSkillsLayer(input.skills),
    compileAgentLayer(input.agent)
  ].flatMap((message) => (message ? [message] : []))

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
    return removeEmptyMessages([...systemLayers, ...historyMessages])
  }

  const result = [...historyMessages]
  // Find the last user message and append turn context to it.
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      result[i] = appendTurnContextToUserMessage(result[i], turnContextParts)
      return removeEmptyMessages([...systemLayers, ...result])
    }
  }

  // No user message in history — create a standalone turn context message.
  return removeEmptyMessages([
    ...systemLayers,
    ...result,
    { role: 'user', content: turnContextParts.join('\n\n') }
  ])
}
