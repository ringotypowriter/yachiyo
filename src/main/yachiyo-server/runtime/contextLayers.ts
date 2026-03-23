import type { MessageImageRecord } from '../../../shared/yachiyo/protocol.ts'
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
}

export interface PersonalityLayerInput {
  basePersona: string
  evolvedTraits?: string[]
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

function toModelHistoryMessage(message: ContextLayerHistoryMessage): ModelMessage {
  if (message.role !== 'user') {
    return {
      role: message.role,
      content: message.content
    }
  }

  const images = normalizeMessageImages(message.images)
  if (images.length === 0) {
    return {
      role: 'user',
      content: message.content
    }
  }

  return {
    role: 'user',
    content: [
      ...(message.content.trim().length > 0
        ? [{ type: 'text' as const, text: message.content }]
        : []),
      ...images.map((image) => ({
        type: 'image' as const,
        image: extractBase64DataUrlPayload(image.dataUrl)?.base64 ?? image.dataUrl,
        mediaType: image.mediaType
      }))
    ]
  }
}

function normalizeLines(lines: string[] | undefined): string[] {
  return lines?.map((line) => line.trim()).filter(Boolean) ?? []
}

export function compilePersonalityLayer(input: PersonalityLayerInput): ModelMessage | null {
  const basePersona = input.basePersona.trim()
  if (!basePersona) {
    return null
  }

  const evolvedTraits = normalizeLines(input.evolvedTraits)
  if (evolvedTraits.length === 0) {
    return {
      role: 'system',
      content: basePersona
    }
  }

  return {
    role: 'system',
    content: [
      basePersona,
      '',
      '以下是来自 SOUL 的人格补充，请自然吸收并保持整体稳定：',
      ...evolvedTraits.map((trait) => `- ${trait}`)
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
  return removeEmptyMessages([
    ...[
      compilePersonalityLayer(input.personality),
      compileUserLayer(input.user),
      compileSkillsLayer(input.skills),
      compileAgentLayer(input.agent),
      compileHintLayer(input.hint),
      compileMemoryLayer(input.memory)
    ].flatMap((message) => (message ? [message] : [])),
    ...input.history.map(toModelHistoryMessage)
  ])
}
