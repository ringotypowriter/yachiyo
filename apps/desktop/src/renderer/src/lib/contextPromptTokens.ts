import type { RunRecord } from '@renderer/app/types'

function runSortKey(run: RunRecord): string {
  return run.completedAt ?? run.createdAt
}

interface ContextTokenInput {
  latestRun: RunRecord | null | undefined
  runs: RunRecord[]
}

function selectContextRun({ latestRun, runs }: ContextTokenInput): RunRecord | undefined {
  if (!latestRun) return undefined
  if (latestRun.status !== 'cancelled') return latestRun
  return runs
    .filter(
      (run) =>
        run.id !== latestRun.id && run.status === 'completed' && run.promptTokens !== undefined
    )
    .sort((left, right) => runSortKey(right).localeCompare(runSortKey(left)))[0]
}

export function selectContextPromptTokens(input: ContextTokenInput): number | null {
  return selectContextRun(input)?.promptTokens ?? null
}

/** Latest measured input plus its output, not cumulative run consumption. */
export function selectContextTokens(input: ContextTokenInput): number | null {
  const run = selectContextRun(input)
  if (run?.promptTokens == null) return null
  return run.promptTokens + (run.lastCompletionTokens ?? 0)
}
