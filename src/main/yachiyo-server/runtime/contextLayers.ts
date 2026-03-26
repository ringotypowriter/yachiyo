import type { MessageFileAttachment, MessageImageRecord } from '../../../shared/yachiyo/protocol.ts'
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

function toModelHistoryMessages(message: ContextLayerHistoryMessage): ModelMessage[] {
  if (message.role !== 'user') {
    if (message.responseMessages && message.responseMessages.length > 0) {
      return message.responseMessages as ModelMessage[]
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
  const textContent = attachedFilesBlock
    ? `${message.content}\n\n${attachedFilesBlock}`
    : message.content

  if (images.length === 0) {
    return [
      {
        role: 'user',
        content: textContent
      }
    ]
  }

  return [
    {
      role: 'user',
      content: [
        ...(textContent.trim().length > 0 ? [{ type: 'text' as const, text: textContent }] : []),
        ...images.map((image) => ({
          type: 'image' as const,
          image: extractBase64DataUrlPayload(image.dataUrl)?.base64 ?? image.dataUrl,
          mediaType: image.mediaType
        }))
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
      '以下是来自 SOUL.md 的自我模型与人格延续记录，请整体吸收并自然融入当前人格：',
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
      '以下是来自 USER.md 的稳定用户理解，请把它当作长期协作画像，而不是当前临时任务状态：',
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
      '以下是当前这次运行里已激活的 Skills。默认只看名称和简介；如果需要详细内容，请使用 skillsRead 按名称读取对应的 SKILL.md：',
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

export function compileContextLayers(input: CompileContextLayersInput): ModelMessage[] {
  const systemLayers = [
    compilePersonalityLayer(input.personality),
    compileSoulLayer(input.soul),
    compileUserLayer(input.user),
    compileSkillsLayer(input.skills),
    compileAgentLayer(input.agent)
  ].flatMap((message) => (message ? [message] : []))

  const historyMessages = input.history.flatMap(toModelHistoryMessages)

  // Turn context is injected mid-conversation, so it must use the user role —
  // only one system message (the stable prefix) is supported by most providers.
  // Hint and memory layers always produce string content.
  const turnContextLayers: ModelMessage[] = [
    compileHintLayer(input.hint),
    compileMemoryLayer(input.memory)
  ].flatMap((message) =>
    message ? [{ role: 'user' as const, content: message.content as string }] : []
  )

  if (turnContextLayers.length === 0) {
    return removeEmptyMessages([...systemLayers, ...historyMessages])
  }

  // Place turn context immediately before the current user query (last user message).
  // This keeps durable system layers and prior history stable for prompt caching,
  // while per-turn injections sit right before the request they augment.
  let insertIndex = historyMessages.length
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    if (historyMessages[i].role === 'user') {
      insertIndex = i
      break
    }
  }

  return removeEmptyMessages([
    ...systemLayers,
    ...historyMessages.slice(0, insertIndex),
    ...turnContextLayers,
    ...historyMessages.slice(insertIndex)
  ])
}
