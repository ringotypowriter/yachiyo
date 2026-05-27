export type UsageStatsPeriod = 'day' | 'week' | 'month' | 'year'

export interface UsageStatsBucket {
  periodStart: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  /** Prompt tokens from runs that reported cache data (non-NULL cache_read_tokens). */
  cacheAwarePromptTokens: number
  runCount: number
}

export interface UsageStatsByModel {
  modelId: string
  providerName: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  cacheAwarePromptTokens: number
  runCount: number
}

export interface UsageStatsByWorkspace {
  workspacePath: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  cacheAwarePromptTokens: number
  runCount: number
}

export interface UsageStatsInput {
  period: UsageStatsPeriod
  from?: string
  to?: string
  /** Filter to a specific workspace. Use `'__null__'` to match threads with no workspace. */
  workspacePath?: string
  modelId?: string
  providerName?: string
}

export interface UsageStatsResponse {
  buckets: UsageStatsBucket[]
  byModel: UsageStatsByModel[]
  byWorkspace: UsageStatsByWorkspace[]
  totals: {
    promptTokens: number
    completionTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cacheAwarePromptTokens: number
    runCount: number
  }
}
