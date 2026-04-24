import type { ProviderSettings } from '../../../shared/yachiyo/protocol.ts'
import type { ModelMessage } from './types.ts'
import { toModelHistoryMessages, type ContextLayerHistoryMessage } from './contextLayers.ts'

export interface CompileGroupProbeContextLayersInput {
  stableSystemPrompt: string
  dynamicSystemPrompt: string
  rollingSummary?: string
  history: ContextLayerHistoryMessage[]
  currentTurnContent: string
  requireAssistantReasoningForReplay?: boolean
}

function removeEmptyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => {
    if (typeof message.content === 'string') {
      return message.content.trim().length > 0
    }

    return message.content.length > 0
  })
}

export function requiresAssistantReasoningForGroupProbeReplay(
  settings: Pick<ProviderSettings, 'provider' | 'baseUrl'>
): boolean {
  if (settings.provider !== 'anthropic') {
    return false
  }

  try {
    return new URL(settings.baseUrl).hostname === 'api.deepseek.com'
  } catch {
    return settings.baseUrl.includes('api.deepseek.com')
  }
}

function isSuccessfulGroupMessageSendResult(output: unknown): boolean {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as { type?: unknown; value?: unknown }).type === 'text' &&
    (output as { value?: unknown }).value === 'Message sent.'
  )
}

function hasReplayableGroupMessageSend(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role === 'tool') {
      return message.content.some(
        (part) =>
          part.type === 'tool-result' &&
          part.toolName === 'send_group_message' &&
          isSuccessfulGroupMessageSendResult(part.output)
      )
    }

    return false
  })
}

function sanitizeSyntheticGroupMessageText(text: string): string {
  return text
    .replace(/\[/g, '⟦')
    .replace(/\]/g, '⟧')
    .replace(/<\/?msg[\s>]/gi, '')
}

function extractSuccessfulGroupMessageText(messages: ModelMessage[]): string | null {
  const successfulToolCallIds = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'tool') {
      continue
    }

    for (const part of message.content) {
      if (
        part.type === 'tool-result' &&
        part.toolName === 'send_group_message' &&
        isSuccessfulGroupMessageSendResult(part.output)
      ) {
        successfulToolCallIds.add(part.toolCallId)
      }
    }
  }

  if (successfulToolCallIds.size === 0) {
    return null
  }

  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      continue
    }

    for (const part of message.content) {
      if (
        part.type === 'tool-call' &&
        part.toolName === 'send_group_message' &&
        successfulToolCallIds.has(part.toolCallId)
      ) {
        const input = part.input as { message?: unknown }
        if (typeof input.message === 'string' && input.message.trim().length > 0) {
          return input.message.trim()
        }
      }
    }
  }

  return null
}

function hasReplayableAnthropicReasoning(messages: ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      return false
    }

    return message.content.some((part) => {
      if (part.type !== 'reasoning') {
        return false
      }

      const reasoningPart = part as unknown as {
        providerMetadata?: Record<string, unknown>
        providerOptions?: Record<string, unknown>
      }
      const providerOptions = reasoningPart.providerOptions
      const providerMetadata = reasoningPart.providerMetadata
      const anthropicOptions = providerOptions?.anthropic as Record<string, unknown> | undefined
      const anthropicMetadata = providerMetadata?.anthropic as Record<string, unknown> | undefined

      return Boolean(
        anthropicOptions?.signature ||
        anthropicOptions?.redactedData ||
        anthropicMetadata?.signature ||
        anthropicMetadata?.redactedData
      )
    })
  })
}

function toSafeGroupProbeSelfMessage(messageText: string): ModelMessage {
  return {
    role: 'user',
    content: `<msg from="Yachiyo">${sanitizeSyntheticGroupMessageText(messageText)}</msg>`
  }
}

function toGroupProbeHistoryMessages(
  message: ContextLayerHistoryMessage,
  requireAssistantReasoningForReplay: boolean
): ModelMessage[] {
  if (message.role !== 'assistant') {
    return toModelHistoryMessages(message)
  }

  if (message.responseMessages && message.responseMessages.length > 0) {
    const responseMessages = message.responseMessages as ModelMessage[]
    if (!hasReplayableGroupMessageSend(responseMessages)) {
      return []
    }

    if (!requireAssistantReasoningForReplay || hasReplayableAnthropicReasoning(responseMessages)) {
      return toModelHistoryMessages(message)
    }

    const sentMessageText = extractSuccessfulGroupMessageText(responseMessages)
    return sentMessageText ? [toSafeGroupProbeSelfMessage(sentMessageText)] : []
  }

  return []
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

  const historyMessages = input.history.flatMap((message) =>
    toGroupProbeHistoryMessages(message, input.requireAssistantReasoningForReplay === true)
  )

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
