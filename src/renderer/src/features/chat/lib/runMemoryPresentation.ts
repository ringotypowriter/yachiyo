import type { RunRecord } from '@renderer/app/types'

export interface RunMemorySummary {
  entries: string[]
  runId: string
}

export function findRunMemorySummary(
  runs: RunRecord[],
  requestMessageId: string
): RunMemorySummary | null {
  for (const run of [...runs].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  )) {
    if (run.requestMessageId !== requestMessageId) {
      continue
    }

    const entries = run.recalledMemoryEntries?.filter((entry) => entry.trim().length > 0) ?? []
    if (entries.length === 0) {
      return null
    }

    return {
      entries,
      runId: run.id
    }
  }

  return null
}
