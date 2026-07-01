import type { MessageRecord, ProviderSettings, ThreadRecord } from '@yachiyo/shared/protocol'
import { estimateTextTokens } from '@yachiyo/shared/estimateTokens'
import type { AuxiliaryGenerationService } from '../../runtime/models/auxiliaryGeneration.ts'
import type { ModelMessage } from '../../runtime/models/types.ts'
import { extractSuccessfulGroupMessageText } from '../../runtime/context/groupProbeContextLayers.ts'
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
 * Choose the watermark checkpoint for one handoff pass. Two bounds:
 *  - keep ~`recentWindowTokens` of raw transcript AFTER the checkpoint, and
 *  - summarize at most ~`maxSegmentTokens` of the OLDEST transcript in this pass
 *    so an already-huge thread never sends a segment larger than the model can
 *    take (the rolling summary folds the backlog in over successive passes).
 * The boundary is then snapped older to a turn start so the kept tail begins
 * with a user delta (the read path slices strictly after the watermark).
 * Returns null when there is nothing clean worth compressing this pass.
 */
export function pickGroupHandoffCheckpoint(
  messages: MessageRecord[],
  recentWindowTokens: number,
  maxSegmentTokens: number
): string | null {
  if (messages.length < 2 || recentWindowTokens <= 0) {
    return null
  }

  // Latest first-kept index that still leaves ~one window of raw after it.
  let tailTokens = 0
  let windowStart = -1
  for (let i = messages.length - 1; i >= 1; i--) {
    tailTokens += estimateTextTokens(messages[i]!.content)
    if (tailTokens >= recentWindowTokens) {
      windowStart = i
      break
    }
  }
  if (windowStart < 0) {
    return null
  }

  // Cap the summarized segment to the oldest ~maxSegmentTokens so this pass's
  // transcript stays within the model's context.
  let start = windowStart
  if (maxSegmentTokens > 0) {
    let segmentTokens = 0
    for (let i = 0; i < messages.length; i++) {
      segmentTokens += estimateTextTokens(messages[i]!.content)
      if (segmentTokens >= maxSegmentTokens) {
        start = Math.min(windowStart, i + 1)
        break
      }
    }
  }

  // Snap the boundary older to a turn start: the kept tail must begin with a
  // user delta so its assistant reply keeps the group context it answered.
  while (start > 0 && messages[start]!.role !== 'user') {
    start--
  }
  if (start <= 0 || messages[start]!.role !== 'user') {
    return null
  }
  return messages[start - 1]!.id
}

function renderSegmentTranscript(messages: MessageRecord[]): string {
  return messages
    .map((message) => {
      if (message.role === 'assistant') {
        // Group probe assistant turns store the sent text in responseMessages
        // (visibleReply is not set), so pull it out — otherwise the summary
        // loses Yachiyo's own replies and the stance/continuity it should keep.
        const said =
          message.visibleReply?.trim() ||
          extractSuccessfulGroupMessageText((message.responseMessages ?? []) as ModelMessage[]) ||
          ''
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
  /**
   * Raw post-watermark transcript size (tokens) that triggers compaction.
   * Measured from stored messages, NOT the last prompt — B already caps the
   * prompt at recentWindowTokens, so prompt size never reflects raw growth.
   */
  handoffThresholdTokens: number
  groupName: string
  settingsOverride?: ProviderSettings
  now?: () => string
}

function estimateRawTokens(messages: MessageRecord[]): number {
  let total = 0
  for (const message of messages) {
    total += estimateTextTokens(message.content)
  }
  return total
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

  const startingWatermark = thread.contextHandoffWatermarkMessageId
  const afterWatermark = messagesAfterWatermark(
    input.storage.listThreadMessages(input.threadId),
    startingWatermark
  )
  // Gate on the raw stored transcript that has piled up since the last
  // watermark — this is what actually grows; the prompt is capped by B.
  if (estimateRawTokens(afterWatermark) < input.handoffThresholdTokens) {
    return 'skipped'
  }
  // Summarize at most one window of the oldest backlog per pass so the segment
  // never exceeds the model's context, even for an already-huge thread.
  const checkpointId = pickGroupHandoffCheckpoint(
    afterWatermark,
    input.recentWindowTokens,
    input.recentWindowTokens
  )
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

  // Re-read: the thread may have changed while the summary was generating. Bail
  // if it was cleared or handed off in the meantime — otherwise we'd write a
  // summary of just-cleared history or a watermark pointing at a deleted
  // message. Guard on both the watermark moving and the checkpoint surviving.
  const latest = input.storage.getThread(input.threadId)
  if (!latest || latest.contextHandoffWatermarkMessageId !== startingWatermark) {
    return 'skipped'
  }
  const checkpointSurvives = input.storage
    .listThreadMessages(input.threadId)
    .some((message) => message.id === checkpointId)
  if (!checkpointSurvives) {
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
