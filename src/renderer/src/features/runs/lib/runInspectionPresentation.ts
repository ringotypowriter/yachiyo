import type { RunContextSourceSummary, RunRecord, ToolCall } from '../../../app/types.ts'

export interface ThreadContextSource {
  kind: 'thread'
  messageCount: number
  workspacePath: string | null
}

/**
 * The combined context source type for the inspection view model.
 *
 * Thread is always renderer-derived and appears first. All other sources come
 * from RunRecord.contextSources, populated server-side during context
 * compilation. Sources not listed were either absent this run or pre-date
 * this feature.
 */
export type ContextSource = ThreadContextSource | RunContextSourceSummary

export interface RunInspectionViewModel {
  run: RunRecord | null
  toolCalls: ToolCall[]
  contextSources: ContextSource[]
}

/**
 * Builds the view-model for the run inspection panel.
 *
 * Picks the latest run by createdAt, prepends the renderer-derived thread
 * source, and appends the server-populated context sources from the run
 * record. Returns a null run when no runs are present.
 */
export function buildRunInspectionViewModel(
  runs: RunRecord[],
  toolCalls: ToolCall[],
  thread: { workspacePath?: string } | null,
  messageCount: number
): RunInspectionViewModel {
  const threadSource: ThreadContextSource = {
    kind: 'thread',
    messageCount,
    workspacePath: thread?.workspacePath ?? null
  }

  if (runs.length === 0) {
    return { run: null, toolCalls: [], contextSources: [threadSource] }
  }

  const latestRun = runs.reduce((latest, run) => (run.createdAt > latest.createdAt ? run : latest))

  const runToolCalls = toolCalls
    .filter((tc) => tc.runId === latestRun.id)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  const contextSources: ContextSource[] = [threadSource, ...(latestRun.contextSources ?? [])]

  return { run: latestRun, toolCalls: runToolCalls, contextSources }
}
