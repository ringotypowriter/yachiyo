import type { ModelMessage } from './types.ts'
import { toModelHistoryMessages, type ContextLayerHistoryMessage } from './contextLayers.ts'

export interface CompileGroupProbeContextLayersInput {
  stableSystemPrompt: string
  dynamicSystemPrompt: string
  rollingSummary?: string
  history: ContextLayerHistoryMessage[]
  currentTurnContent: string
}

function removeEmptyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => {
    if (typeof message.content === 'string') {
      return message.content.trim().length > 0
    }

    return message.content.length > 0
  })
}

const STRONG_SENTENCE_STOP_PATTERN = /[.!?。！？]/g

function trimReplayDecisionTail(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return ''
  }

  const matches = Array.from(trimmed.matchAll(STRONG_SENTENCE_STOP_PATTERN))
  if (matches.length < 2) {
    return trimmed
  }

  const secondLastMatch = matches.at(-2)
  if (!secondLastMatch || secondLastMatch.index == null) {
    return ''
  }

  return trimmed.slice(0, secondLastMatch.index + secondLastMatch[0].length).trim()
}

function hasReplayableGroupMessageSend(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role === 'tool') {
      return message.content.some(
        (part) => part.type === 'tool-result' && part.toolName === 'send_group_message'
      )
    }

    if (message.role !== 'assistant' || typeof message.content === 'string') {
      return false
    }

    return message.content.some(
      (part) => part.type === 'tool-call' && part.toolName === 'send_group_message'
    )
  })
}

function trimAssistantReplayResponseMessages(responseMessages: unknown[]): unknown[] {
  const messages = responseMessages as ModelMessage[]
  if (hasReplayableGroupMessageSend(messages)) {
    return responseMessages
  }

  const trimmedMessages = [...messages]

  for (let messageIndex = trimmedMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = trimmedMessages[messageIndex]
    if (message.role !== 'assistant') {
      continue
    }

    if (typeof message.content === 'string') {
      trimmedMessages[messageIndex] = {
        ...message,
        content: trimReplayDecisionTail(message.content)
      }
      break
    }

    const content = [...message.content]
    for (let contentIndex = content.length - 1; contentIndex >= 0; contentIndex -= 1) {
      const part = content[contentIndex]
      if (part.type !== 'text') {
        continue
      }

      content[contentIndex] = { ...part, text: trimReplayDecisionTail(part.text) }
      trimmedMessages[messageIndex] = { ...message, content }
      break
    }

    if (trimmedMessages[messageIndex] !== message) {
      break
    }
  }

  return trimmedMessages
}

function trimGroupProbeReplayHistoryMessage(
  message: ContextLayerHistoryMessage
): ContextLayerHistoryMessage {
  if (message.role !== 'assistant') {
    return message
  }

  if (message.responseMessages && message.responseMessages.length > 0) {
    return {
      ...message,
      responseMessages: trimAssistantReplayResponseMessages(message.responseMessages)
    }
  }

  return {
    ...message,
    content: trimReplayDecisionTail(message.content)
  }
}

export function compileGroupProbeContextLayers(
  input: CompileGroupProbeContextLayersInput
): ModelMessage[] {
  const systemPrefix: ModelMessage[] = []
  if (input.stableSystemPrompt.trim()) {
    systemPrefix.push({ role: 'system', content: input.stableSystemPrompt.trim() })
  }
  if (input.dynamicSystemPrompt.trim()) {
    systemPrefix.push({ role: 'system', content: input.dynamicSystemPrompt.trim() })
  }

  const summaryMessages: ModelMessage[] = input.rollingSummary?.trim()
    ? [
        {
          role: 'user',
          content: [
            '<conversation_summary>',
            input.rollingSummary.trim(),
            '</conversation_summary>'
          ].join('\n')
        }
      ]
    : []

  const historyMessages = input.history
    .map(trimGroupProbeReplayHistoryMessage)
    .flatMap(toModelHistoryMessages)

  const currentTurn: ModelMessage[] = input.currentTurnContent.trim()
    ? [{ role: 'user', content: input.currentTurnContent.trim() }]
    : []

  return removeEmptyMessages([
    ...systemPrefix,
    ...summaryMessages,
    ...historyMessages,
    ...currentTurn
  ])
}
