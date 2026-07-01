import type { ProviderSettings } from '@yachiyo/shared/protocol'
import { estimateTextTokens } from '@yachiyo/shared/estimateTokens'
import type { ModelMessage } from '../models/types.ts'
import { toModelHistoryMessages, type ContextLayerHistoryMessage } from './contextLayers.ts'

export interface CompileGroupProbeContextLayersInput {
  stableSystemPrompt: string
  dynamicSystemPrompt: string
  contextHandoffSummary?: string
  history: ContextLayerHistoryMessage[]
  currentTurnContent: string
  requireAssistantReasoningForReplay?: boolean
  /**
   * Token budget for the replayed history. When set, only the most recent
   * whole history turns that fit the budget are kept (at least one always
   * survives). Prevents an ever-growing group thread from drowning the fixed
   * persona and making replies regress to the bland group-average tone.
   */
  historyTokenBudget?: number
  /**
   * Short persona/voice reminder re-asserted right before the current turn.
   * Recency keeps the bot's own voice from being lost in a long history.
   */
  styleReminder?: string
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

function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0
  for (const message of messages) {
    const text =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    total += estimateTextTokens(text)
  }
  return total
}

/**
 * Group persisted history turns into atomic replay units so an assistant/tool
 * reply is never separated from the user delta it responded to. Probe history
 * is stored as a user delta followed by its assistant result; a unit runs from
 * a user turn through the assistant turn(s) that follow it. Empty (silent) turns
 * are skipped.
 */
function groupHistoryIntoReplayUnits(perTurn: ModelMessage[][]): ModelMessage[][] {
  const units: ModelMessage[][] = []
  for (const turn of perTurn) {
    if (turn.length === 0) {
      continue
    }
    const startsNewUnit = turn[0]?.role === 'user' || units.length === 0
    if (startsNewUnit) {
      units.push([...turn])
    } else {
      units[units.length - 1]!.push(...turn)
    }
  }
  return units
}

/**
 * Flatten history to model messages, keeping only the most recent replay units
 * that fit `budget` tokens. Trims at unit boundaries (a user delta and its
 * assistant reply stay together, never orphaning a reply/tool-call) and always
 * keeps at least the newest unit.
 */
function buildBudgetedHistoryMessages(
  history: ContextLayerHistoryMessage[],
  requireAssistantReasoningForReplay: boolean,
  budget?: number
): ModelMessage[] {
  const perTurn = history.map((message) =>
    toGroupProbeHistoryMessages(message, requireAssistantReasoningForReplay)
  )

  if (budget == null || budget <= 0) {
    return perTurn.flat()
  }

  const units = groupHistoryIntoReplayUnits(perTurn)
  const kept: ModelMessage[][] = []
  let total = 0
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i]!
    const unitTokens = estimateMessagesTokens(unit)
    if (total + unitTokens > budget && kept.length > 0) {
      break
    }
    kept.unshift(unit)
    total += unitTokens
  }
  return kept.flat()
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

  const summaryMessages: ModelMessage[] = input.contextHandoffSummary?.trim()
    ? [
        {
          role: 'user',
          content: [
            '<context_handoff>',
            input.contextHandoffSummary.trim(),
            '</context_handoff>'
          ].join('\n')
        }
      ]
    : []

  const historyMessages = buildBudgetedHistoryMessages(
    input.history,
    input.requireAssistantReasoningForReplay === true,
    input.historyTokenBudget
  )

  // Re-assert the persona right before the current turn, but only when there is
  // history to counteract — a fresh thread's system prompt is not yet diluted.
  const styleReminderMessages: ModelMessage[] =
    input.styleReminder?.trim() && historyMessages.length > 0
      ? [
          {
            role: 'user',
            content: ['<style_reminder>', input.styleReminder.trim(), '</style_reminder>'].join(
              '\n'
            )
          }
        ]
      : []

  const currentTurn: ModelMessage[] = input.currentTurnContent.trim()
    ? [{ role: 'user', content: input.currentTurnContent.trim() }]
    : []

  return removeEmptyMessages([
    ...systemPrefix,
    ...summaryMessages,
    ...historyMessages,
    ...styleReminderMessages,
    ...currentTurn
  ])
}
