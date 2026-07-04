import type { MessageRecord } from '@yachiyo/shared/protocol'
import { collectMessagePath } from '@yachiyo/shared/threadTree'
import type { ListThreadMessagesOptions, YachiyoStorage } from '../../../../storage/storage.ts'
import type { ModelUsage } from '../../../../runtime/models/types.ts'
import type { UsageFields } from '../runUsageFields.ts'

export type PriorRunUsage = UsageFields

/** Merge prior steer-leg totals into the current leg's usage for final persistence. */
export function mergeRunUsage(
  prior: PriorRunUsage | undefined,
  current: ModelUsage | undefined
): ModelUsage | undefined {
  if (!prior) return current
  if (!current) {
    return {
      promptTokens: prior.promptTokens ?? 0,
      completionTokens: prior.completionTokens ?? 0,
      totalPromptTokens: prior.totalPromptTokens ?? 0,
      totalCompletionTokens: prior.totalCompletionTokens ?? 0,
      cacheReadTokens: prior.cacheReadTokens ?? 0,
      cacheWriteTokens: prior.cacheWriteTokens ?? 0
    }
  }
  return {
    ...current,
    promptTokens: current.promptTokens,
    completionTokens: (prior.completionTokens ?? 0) + current.completionTokens,
    totalPromptTokens: (prior.totalPromptTokens ?? 0) + current.totalPromptTokens,
    totalCompletionTokens: (prior.totalCompletionTokens ?? 0) + current.totalCompletionTokens,
    cacheReadTokens: (prior.cacheReadTokens ?? 0) + (current.cacheReadTokens ?? 0),
    cacheWriteTokens: (prior.cacheWriteTokens ?? 0) + (current.cacheWriteTokens ?? 0)
  }
}

/** Get the most recent completed run's actual prompt tokens on the same branch. */
export function getPreviousRunActualPromptTokens(
  storage: Pick<YachiyoStorage, 'listThreadRuns'>,
  loadThreadMessages: (threadId: string, options?: ListThreadMessagesOptions) => MessageRecord[],
  threadId: string,
  currentRunId: string,
  currentRequestMessageId: string
): number | undefined {
  // Only the branch path's message ids are needed — skip the transcripts.
  const messagePath = collectMessagePath(
    loadThreadMessages(threadId, { includeResponseMessages: false }),
    currentRequestMessageId
  )
  const messageIdsInPath = new Set(messagePath.map((m) => m.id))

  const runs = storage.listThreadRuns(threadId)
  const previousRuns = runs.filter(
    (run) =>
      run.id !== currentRunId &&
      run.status === 'completed' &&
      run.promptTokens != null &&
      run.requestMessageId != null &&
      messageIdsInPath.has(run.requestMessageId)
  )
  if (previousRuns.length === 0) return undefined
  previousRuns.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
  return previousRuns[0].promptTokens
}
