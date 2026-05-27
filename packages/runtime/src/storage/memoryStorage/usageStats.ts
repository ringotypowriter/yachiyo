import type {
  UsageStatsBucket,
  UsageStatsByModel,
  UsageStatsByWorkspace,
  UsageStatsInput,
  UsageStatsResponse
} from '@yachiyo/shared/protocol'
import type { StoredRunRow, StoredThreadRow } from '../storage.ts'

export function getInMemoryUsageStats(
  input: UsageStatsInput,
  runRows: Iterable<StoredRunRow>,
  threads: Map<string, StoredThreadRow>
): UsageStatsResponse {
  const completedRuns = [...runRows].filter((run) => {
    if (run.status !== 'completed' || !run.completedAt) return false
    if (input.from && run.completedAt < input.from) return false
    if (input.to && run.completedAt > input.to) return false
    if (input.modelId && run.modelId !== input.modelId) return false
    if (input.providerName && run.providerName !== input.providerName) return false
    if (input.workspacePath) {
      const thread = threads.get(run.threadId)
      if (input.workspacePath === '__null__') {
        if (thread?.workspacePath != null) return false
      } else if (thread?.workspacePath !== input.workspacePath) {
        return false
      }
    }
    return true
  })

  const bucketMap = new Map<string, UsageStatsBucket>()
  for (const run of completedRuns) {
    const key = formatUsagePeriod(run.completedAt!, input.period)
    const bucket = bucketMap.get(key) ?? {
      periodStart: key,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      cacheAwarePromptTokens: 0,
      runCount: 0
    }
    addRunToUsageTotals(bucket, run)
    bucketMap.set(key, bucket)
  }

  const modelMap = new Map<string, UsageStatsByModel>()
  for (const run of completedRuns) {
    if (!run.modelId) continue
    const key = `${run.modelId}|${run.providerName ?? 'unknown'}`
    const model = modelMap.get(key) ?? {
      modelId: run.modelId,
      providerName: run.providerName ?? 'unknown',
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      cacheAwarePromptTokens: 0,
      runCount: 0
    }
    addRunToUsageTotals(model, run)
    modelMap.set(key, model)
  }

  const workspaceMap = new Map<string, UsageStatsByWorkspace>()
  for (const run of completedRuns) {
    const thread = threads.get(run.threadId)
    const workspacePath = thread?.workspacePath ?? '__null__'
    const workspace = workspaceMap.get(workspacePath) ?? {
      workspacePath,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      cacheAwarePromptTokens: 0,
      runCount: 0
    }
    addRunToUsageTotals(workspace, run)
    workspaceMap.set(workspacePath, workspace)
  }

  const totals = {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheAwarePromptTokens: 0,
    runCount: completedRuns.length
  }
  for (const run of completedRuns) {
    totals.promptTokens += run.totalPromptTokens ?? 0
    totals.completionTokens += run.totalCompletionTokens ?? 0
    totals.cacheReadTokens += run.cacheReadTokens ?? 0
    totals.cacheWriteTokens += run.cacheWriteTokens ?? 0
    if (run.cacheReadTokens != null) totals.cacheAwarePromptTokens += run.totalPromptTokens ?? 0
  }

  return {
    buckets: [...bucketMap.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart)),
    byModel: [...modelMap.values()].sort((a, b) => b.totalPromptTokens - a.totalPromptTokens),
    byWorkspace: [...workspaceMap.values()].sort(
      (a, b) => b.totalPromptTokens - a.totalPromptTokens
    ),
    totals
  }
}

function formatUsagePeriod(date: string, period: UsageStatsInput['period']): string {
  const day = date.slice(0, 10)
  switch (period) {
    case 'year':
      return day.slice(0, 4)
    case 'month':
      return day.slice(0, 7)
    case 'week': {
      const value = new Date(day)
      const jan1 = new Date(value.getFullYear(), 0, 1)
      const weekNum = Math.ceil(
        ((value.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7
      )
      return `${value.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
    }
    default:
      return day
  }
}

function addRunToUsageTotals(
  totals: {
    totalPromptTokens: number
    totalCompletionTokens: number
    totalCacheReadTokens: number
    totalCacheWriteTokens: number
    cacheAwarePromptTokens: number
    runCount: number
  },
  run: StoredRunRow
): void {
  totals.totalPromptTokens += run.totalPromptTokens ?? 0
  totals.totalCompletionTokens += run.totalCompletionTokens ?? 0
  totals.totalCacheReadTokens += run.cacheReadTokens ?? 0
  totals.totalCacheWriteTokens += run.cacheWriteTokens ?? 0
  if (run.cacheReadTokens != null) totals.cacheAwarePromptTokens += run.totalPromptTokens ?? 0
  totals.runCount++
}
