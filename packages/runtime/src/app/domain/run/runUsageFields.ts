import type { ModelUsage } from '../../../runtime/models/types.ts'

export type UsageFields = Pick<
  ModelUsage,
  | 'lastCompletionTokens'
  | 'promptTokens'
  | 'completionTokens'
  | 'totalPromptTokens'
  | 'totalCompletionTokens'
  | 'timeToFirstTokenMs'
  | 'modelGenerationDurationMs'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
>

export function usageFieldsFrom(usage: UsageFields | undefined): Partial<UsageFields> {
  if (!usage) return {}
  return {
    promptTokens: usage.promptTokens,
    lastCompletionTokens: usage.lastCompletionTokens,
    completionTokens: usage.completionTokens,
    totalPromptTokens: usage.totalPromptTokens,
    totalCompletionTokens: usage.totalCompletionTokens,
    timeToFirstTokenMs: usage.timeToFirstTokenMs,
    modelGenerationDurationMs: usage.modelGenerationDurationMs,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens
  }
}
