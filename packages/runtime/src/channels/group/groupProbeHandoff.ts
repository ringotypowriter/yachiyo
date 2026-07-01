import type { MessageRecord, ProviderSettings, ThreadRecord } from '@yachiyo/shared/protocol'
import { estimateTextTokens } from '@yachiyo/shared/estimateTokens'
import type { AuxiliaryGenerationService } from '../../runtime/models/auxiliaryGeneration.ts'
import {
  GROUP_HANDOFF_SYSTEM_PROMPT,
  buildGroupHandoffSummaryPrompt
} from '../../runtime/context/prompt.ts'

interface GroupHandoffStorage {
  getThread(threadId: string): ThreadRecord | undefined
  listThreadMessages(threadId: string): MessageRecord[]
  updateThread(thread: ThreadRecord): void
}

export function messagesAfterWatermark(
  messages: MessageRecord[],
  watermarkMessageId?: string
): MessageRecord[] {
  if (!watermarkMessageId) {
    return messages
  }
  const index = messages.findIndex((message) => message.id === watermarkMessageId)
  return index >= 0 ? messages.slice(index + 1) : messages
}

/**
 * Choose the watermark checkpoint so the transcript kept *after* it is roughly
 * `recentWindowTokens` — everything up to and including the checkpoint gets
 * summarized. Walks newest-first and returns the message just before the point
 * where the recent tail reaches the window. Returns null when there is nothing
 * worth compressing (thread already fits the window).
 */
export function pickGroupHandoffCheckpoint(
  messages: MessageRecord[],
  recentWindowTokens: number
): string | null {
  if (messages.length < 2 || recentWindowTokens <= 0) {
    return null
  }
  let tailTokens = 0
  for (let i = messages.length - 1; i >= 1; i--) {
    tailTokens += estimateTextTokens(messages[i]!.content)
    if (tailTokens >= recentWindowTokens) {
      return messages[i - 1]!.id
    }
  }
  return null
}

function renderSegmentTranscript(messages: MessageRecord[]): string {
  return messages
    .map((message) => {
      if (message.role === 'assistant') {
        const said = (message.visibleReply ?? '').trim()
        return said ? `Yachiyo: ${said}` : ''
      }
      return message.content.trim()
    })
    .filter((line) => line.length > 0)
    .join('\n')
}

export interface SummarizeGroupProbeContextInput {
  storage: GroupHandoffStorage
  auxService: Pick<AuxiliaryGenerationService, 'generateText'>
  threadId: string
  /** Tokens of raw transcript to keep after the watermark (the B-window). */
  recentWindowTokens: number
  groupName: string
  settingsOverride?: ProviderSettings
  now?: () => string
}

/**
 * Compress the older part of a long-running group probe thread into a rolling
 * conversational-continuity summary and advance the context handoff watermark,
 * in place (no new thread). The read path already replays
 * `contextHandoffSummary` + post-watermark transcript, so this only writes.
 */
export async function summarizeGroupProbeContext(
  input: SummarizeGroupProbeContextInput
): Promise<'summarized' | 'skipped'> {
  const thread = input.storage.getThread(input.threadId)
  if (!thread) {
    return 'skipped'
  }

  const afterWatermark = messagesAfterWatermark(
    input.storage.listThreadMessages(input.threadId),
    thread.contextHandoffWatermarkMessageId
  )
  const checkpointId = pickGroupHandoffCheckpoint(afterWatermark, input.recentWindowTokens)
  if (!checkpointId) {
    return 'skipped'
  }

  const checkpointIndex = afterWatermark.findIndex((message) => message.id === checkpointId)
  const segment = afterWatermark.slice(0, checkpointIndex + 1)
  const transcript = renderSegmentTranscript(segment)
  if (!transcript) {
    return 'skipped'
  }

  const result = await input.auxService.generateText({
    messages: [
      { role: 'system', content: GROUP_HANDOFF_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildGroupHandoffSummaryPrompt({
          groupName: input.groupName,
          previousSummary: thread.contextHandoffSummary,
          transcript
        })
      }
    ],
    ...(input.settingsOverride ? { settingsOverride: input.settingsOverride } : {}),
    purpose: 'group-probe-handoff'
  })
  if (result.status !== 'success') {
    return 'skipped'
  }
  const summary = result.text.trim()
  if (!summary) {
    return 'skipped'
  }

  // Re-read: the thread may have changed while the summary was generating.
  const latest = input.storage.getThread(input.threadId)
  if (!latest) {
    return 'skipped'
  }
  input.storage.updateThread({
    ...latest,
    contextHandoffSummary: summary,
    contextHandoffWatermarkMessageId: checkpointId,
    updatedAt: input.now ? input.now() : new Date().toISOString()
  })
  return 'summarized'
}
