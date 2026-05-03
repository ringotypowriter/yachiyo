import type { ModelUsage } from '../../../../runtime/types.ts'

export type UsageFields = Pick<
  ModelUsage,
  | 'promptTokens'
  | 'completionTokens'
  | 'totalPromptTokens'
  | 'totalCompletionTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
>

/** Extract the six token-count fields for passing to cancelRun/failRun. */
export function usageFieldsFrom(usage: UsageFields | undefined): Partial<UsageFields> {
  if (!usage) return {}
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalPromptTokens: usage.totalPromptTokens,
    totalCompletionTokens: usage.totalCompletionTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens
  }
}

/** Merge accumulated prior-leg totals with the current leg's ModelUsage for terminal persistence. */
export function mergeUsageForTerminal(
  prior: UsageFields | undefined,
  current: ModelUsage | undefined
): UsageFields | undefined {
  if (!prior && !current) return undefined
  if (!prior) return current
  if (!current) return prior
  return {
    promptTokens: current.promptTokens,
    completionTokens: (prior.completionTokens ?? 0) + current.completionTokens,
    totalPromptTokens: (prior.totalPromptTokens ?? 0) + current.totalPromptTokens,
    totalCompletionTokens: (prior.totalCompletionTokens ?? 0) + current.totalCompletionTokens,
    cacheReadTokens: (prior.cacheReadTokens ?? 0) + (current.cacheReadTokens ?? 0),
    cacheWriteTokens: (prior.cacheWriteTokens ?? 0) + (current.cacheWriteTokens ?? 0)
  }
}
