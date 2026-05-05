import type { MessageRecord } from '../../../../../../shared/yachiyo/protocol.ts'
import { collectMessagePath } from '../../../../../../shared/yachiyo/threadTree.ts'
import {
  repairReplayHistoryMessages,
  type ReplayHistoryMessage
} from '../../../../runtime/messages/replayHistoryRepair.ts'
import type { YachiyoStorage } from '../../../../storage/storage.ts'

/**
 * Ensure every tool-call in an assistant message has a matching tool-result in
 * the subsequent tool/user message. Parallel tool calls that were interrupted
 * (e.g. by a steer stopping the model loop mid-step) may leave orphaned
 * tool_use blocks that cause the next API call to fail validation.
 *
 * Returns the original array if already balanced.
 */
export function balanceResponseMessages(messages: unknown[]): unknown[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages

  let modified = false
  const result = [...messages]

  for (let i = 0; i < result.length; i++) {
    const msg = result[i] as { role?: string; content?: unknown[] }
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue

    const toolCallIds = new Set<string>()
    for (const part of msg.content) {
      const p = part as { type?: string; toolCallId?: string }
      if (p.type === 'tool-call' && p.toolCallId) {
        toolCallIds.add(p.toolCallId)
      }
    }
    if (toolCallIds.size === 0) continue

    for (let j = i + 1; j < result.length; j++) {
      const toolMsg = result[j] as { role?: string; content?: unknown[] }
      if (toolMsg?.role !== 'tool' && toolMsg?.role !== 'user') break
      if (!Array.isArray(toolMsg.content)) continue
      for (const part of toolMsg.content) {
        const p = part as { type?: string; toolCallId?: string }
        if ((p.type === 'tool-result' || p.type === 'tool-error') && p.toolCallId) {
          toolCallIds.delete(p.toolCallId)
        }
      }
    }

    if (toolCallIds.size > 0) {
      console.warn(
        `[snapshot] Balancing ${toolCallIds.size} orphaned tool call(s): ${[...toolCallIds].join(', ')}`
      )
      modified = true
      const toolNameById = new Map<string, string>()
      for (const part of msg.content) {
        const p = part as { type?: string; toolCallId?: string; toolName?: string }
        if (p.type === 'tool-call' && p.toolCallId && p.toolName) {
          toolNameById.set(p.toolCallId, p.toolName)
        }
      }
      const syntheticResults = [...toolCallIds].map((toolCallId) => ({
        type: 'tool-result' as const,
        toolCallId,
        toolName: toolNameById.get(toolCallId) ?? 'unknown',
        output: { type: 'text', value: '[Interrupted by steer before tool result was received]' }
      }))

      const nextIdx = i + 1
      const next = result[nextIdx] as { role?: string; content?: unknown[] } | undefined
      if (next && (next.role === 'tool' || next.role === 'user') && Array.isArray(next.content)) {
        result[nextIdx] = { ...next, content: [...next.content, ...syntheticResults] }
      } else {
        result.splice(nextIdx, 0, { role: 'tool', content: syntheticResults })
      }
    }
  }

  return modified ? result : messages
}

export type RunHistoryMessage = Pick<
  MessageRecord,
  'content' | 'images' | 'attachments' | 'role' | 'responseMessages' | 'turnContext'
>

export function toRunHistoryMessages(
  messagePath: ReplayHistoryMessage[],
  requestMessageId: string,
  requestMessageContentOverride?: string,
  /** If set, only messages after this legacy external-summary watermark are included. */
  summaryWatermarkMessageId?: string
): RunHistoryMessage[] {
  let effectivePath = messagePath

  if (summaryWatermarkMessageId) {
    const watermarkIndex = effectivePath.findIndex((m) => m.id === summaryWatermarkMessageId)
    if (watermarkIndex >= 0) {
      effectivePath = effectivePath.slice(watermarkIndex + 1)
    }
  }

  return effectivePath.map(
    ({ content, id, images, attachments, role, responseMessages, turnContext }) => {
      const isCurrentRequest = id === requestMessageId
      return {
        content: isCurrentRequest ? (requestMessageContentOverride ?? content) : content,
        ...(images ? { images } : {}),
        ...(attachments ? { attachments } : {}),
        ...(responseMessages ? { responseMessages } : {}),
        ...(!isCurrentRequest && turnContext ? { turnContext } : {}),
        role
      }
    }
  )
}

export function loadRunHistory(
  loadThreadMessages: (threadId: string) => MessageRecord[],
  storage: Pick<YachiyoStorage, 'persistResponseMessagesRepairInBackground'>,
  threadId: string,
  requestMessageId: string,
  requestMessageContentOverride?: string,
  summaryWatermarkMessageId?: string
): RunHistoryMessage[] {
  const messagePath = repairReplayHistoryMessages({
    messages: collectMessagePath(loadThreadMessages(threadId), requestMessageId),
    persistRepairedResponseMessages: (repair) => {
      storage.persistResponseMessagesRepairInBackground?.(repair)
    }
  })

  return toRunHistoryMessages(
    messagePath,
    requestMessageId,
    requestMessageContentOverride,
    summaryWatermarkMessageId
  )
}
