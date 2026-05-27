import type { RunRecord } from '@renderer/app/types'

function runSortKey(run: RunRecord): string {
  return run.completedAt ?? run.createdAt
}

function findPreviousCompletedPromptTokens(runs: RunRecord[], latestRunId: string): number | null {
  const previousRun = runs
    .filter(
      (run) =>
        run.id !== latestRunId && run.status === 'completed' && run.promptTokens !== undefined
    )
    .sort((left, right) => runSortKey(right).localeCompare(runSortKey(left)))[0]

  return previousRun?.promptTokens ?? null
}

export function selectContextPromptTokens(input: {
  latestRun: RunRecord | null | undefined
  runs: RunRecord[]
}): number | null {
  const { latestRun, runs } = input
  if (!latestRun) return null

  if (latestRun.status === 'cancelled') {
    return findPreviousCompletedPromptTokens(runs, latestRun.id)
  }

  return latestRun.promptTokens ?? null
}
