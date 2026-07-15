import type { MessageRecord, ProviderSettings, ThreadRecord } from '@yachiyo/shared/protocol'
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
 * Choose the watermark checkpoint for one handoff pass: drop the oldest half of
 * the transcript and keep the newer half (the larger half when the count is
 * odd). The boundary is snapped older to a turn start so the kept tail begins
 * with a user delta — its assistant reply then keeps the group context it
 * answered, and the read path slices strictly after the watermark. Returns null
 * when the transcript is too short or has no clean turn boundary to compress.
 */
export function pickGroupHandoffCheckpoint(messages: MessageRecord[]): string | null {
  if (messages.length < 2) {
    return null
  }

  // First index of the kept (newer) half; dropping floor(n/2) keeps the larger
  // half when the count is odd.
  let boundary = Math.floor(messages.length / 2)

  // Snap the boundary older to a turn start so the kept tail opens with a user
  // delta rather than a dangling assistant reply.
  while (boundary > 0 && messages[boundary]!.role !== 'user') {
    boundary--
  }
  if (boundary <= 0) {
    return null
  }
  return messages[boundary - 1]!.id
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
  /**
   * Provider-reported prompt tokens for the probe turn that just ran. This real
   * prompt size — not a transcript-length guess — decides whether the context
   * has grown enough to compact. Undefined when the provider reported no usage.
   */
  promptTokens?: number
  /** Prompt-token size at which a compaction pass is worth running. */
  handoffThresholdTokens: number
  groupName: string
  settingsOverride?: ProviderSettings
  now?: () => string
}

export type SummarizeGroupProbeOutcome =
  | { status: 'summarized'; checkpointId: string }
  | {
      status: 'skipped'
      reason:
        | 'below-prompt-threshold'
        | 'generation-unavailable'
        | 'no-checkpoint'
        | 'prompt-usage-unavailable'
        | 'thread-changed'
    }

/**
 * Compress the older part of a long-running group probe thread into a rolling
 * conversational-continuity summary and advance the context handoff watermark,
 * in place (no new thread). The read path already replays
 * `contextHandoffSummary` + post-watermark transcript, so this only writes.
 */
export async function summarizeGroupProbeContext(
  input: SummarizeGroupProbeContextInput
): Promise<SummarizeGroupProbeOutcome> {
  const thread = input.storage.getThread(input.threadId)
  if (!thread) {
    return { status: 'skipped', reason: 'thread-changed' }
  }

  // Gate on the provider's real prompt size for this turn: no usage means we
  // can't tell whether the context grew, and a small prompt isn't worth a pass.
  if (input.promptTokens === undefined) {
    return { status: 'skipped', reason: 'prompt-usage-unavailable' }
  }
  if (input.promptTokens < input.handoffThresholdTokens) {
    return { status: 'skipped', reason: 'below-prompt-threshold' }
  }

  const startingWatermark = thread.contextHandoffWatermarkMessageId
  const afterWatermark = messagesAfterWatermark(
    input.storage.listThreadMessages(input.threadId),
    startingWatermark
  )
  const checkpointId = pickGroupHandoffCheckpoint(afterWatermark)
  if (!checkpointId) {
    return { status: 'skipped', reason: 'no-checkpoint' }
  }

  const checkpointIndex = afterWatermark.findIndex((message) => message.id === checkpointId)
  const segment = afterWatermark.slice(0, checkpointIndex + 1)
  const transcript = renderSegmentTranscript(segment)
  if (!transcript) {
    return { status: 'skipped', reason: 'no-checkpoint' }
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
    return { status: 'skipped', reason: 'generation-unavailable' }
  }
  const summary = result.text.trim()
  if (!summary) {
    return { status: 'skipped', reason: 'generation-unavailable' }
  }

  // Re-read: the thread may have changed while the summary was generating. Bail
  // if it was cleared or handed off in the meantime — otherwise we'd write a
  // summary of just-cleared history or a watermark pointing at a deleted
  // message. Guard on both the watermark moving and the checkpoint surviving.
  const latest = input.storage.getThread(input.threadId)
  if (!latest || latest.contextHandoffWatermarkMessageId !== startingWatermark) {
    return { status: 'skipped', reason: 'thread-changed' }
  }
  const checkpointSurvives = input.storage
    .listThreadMessages(input.threadId)
    .some((message) => message.id === checkpointId)
  if (!checkpointSurvives) {
    return { status: 'skipped', reason: 'thread-changed' }
  }
  input.storage.updateThread({
    ...latest,
    contextHandoffSummary: summary,
    contextHandoffWatermarkMessageId: checkpointId,
    updatedAt: input.now ? input.now() : new Date().toISOString()
  })
  return { status: 'summarized', checkpointId }
}
