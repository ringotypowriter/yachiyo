import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Clock, Wrench, GitCompareArrows } from 'lucide-react'
import type { RunRecord, ToolCall } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { theme, alpha } from '@renderer/theme/theme'
import { DiffPreviewerModal } from './DiffPreviewerModal'
import { countToolCallsForRun, findLatestRunForRequest } from '../lib/runMemoryPresentation.ts'

interface RunStatsFooterProps {
  runs: RunRecord[]
  toolCalls: ToolCall[]
  requestMessageId: string
}

/** Minimum elapsed seconds before the footer is shown. */
const ELAPSED_THRESHOLD_S = 30
/** Minimum tool call count before the footer is shown. */
const TOOL_CALL_THRESHOLD = 5

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 100) / 10}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function RunStatsFooter({
  runs,
  toolCalls,
  requestMessageId
}: RunStatsFooterProps): React.JSX.Element | null {
  const [showDiffModal, setShowDiffModal] = useState(false)

  const latestRunsByThread = useAppStore((s) => s.latestRunsByThread)
  // Also check the ephemeral event store for runs that just completed
  // (before the RunRecord is refreshed from the database).
  const snapshotReviewByRun = useAppStore((s) => s.snapshotReviewByRun)

  const runInfo = useMemo(() => {
    const run = findLatestRunForRequest(runs, requestMessageId, (candidate) => {
      return candidate.completedAt != null
    })
    if (!run || !run.completedAt) return null

    const elapsedMs = new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()
    // Prefer persisted snapshotFileCount, fall back to ephemeral event
    const fileCount = run.snapshotFileCount ?? snapshotReviewByRun[run.id]?.fileCount ?? 0
    // Count by runId so steer legs that re-anchor to a later requestMessageId
    // still roll up into the original run's footer.
    const toolCallCount = countToolCallsForRun(toolCalls, run.id)
    return {
      elapsedMs,
      runId: run.id,
      threadId: run.threadId,
      fileCount,
      toolCallCount,
      workspacePath: run.workspacePath ?? snapshotReviewByRun[run.id]?.workspacePath ?? ''
    }
  }, [runs, toolCalls, requestMessageId, snapshotReviewByRun])

  const handleOpenDiff = useCallback(() => {
    setShowDiffModal(true)
  }, [])

  const handleCloseDiff = useCallback(() => {
    setShowDiffModal(false)
  }, [])

  if (!runInfo) return null

  const showElapsed = runInfo.elapsedMs >= ELAPSED_THRESHOLD_S * 1000
  const showToolCalls = runInfo.toolCallCount >= TOOL_CALL_THRESHOLD
  const hasSnapshot = runInfo.fileCount > 0 && runInfo.workspacePath.length > 0
  if (!showElapsed && !showToolCalls && !hasSnapshot) return null

  return (
    <>
      <div
        className="message-footer message-footer--always-visible inline-flex items-center gap-2.5"
        style={{ color: theme.text.muted }}
      >
        {showElapsed ? (
          <span className="inline-flex items-center gap-1">
            <Clock size={11} strokeWidth={1.7} />
            {formatElapsed(runInfo.elapsedMs)}
          </span>
        ) : null}
        {showToolCalls ? (
          <span className="inline-flex items-center gap-1">
            <Wrench size={11} strokeWidth={1.7} />
            {runInfo.toolCallCount} tool {runInfo.toolCallCount === 1 ? 'call' : 'calls'}
          </span>
        ) : null}
        {hasSnapshot ? (
          <button
            type="button"
            onClick={handleOpenDiff}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors"
            style={{
              color: theme.text.accent,
              background: alpha('accent', 0.08),
              border: 'none',
              cursor: 'pointer',
              fontSize: 'inherit',
              lineHeight: 'inherit'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = alpha('accent', 0.14)
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = alpha('accent', 0.08)
            }}
          >
            <GitCompareArrows size={11} strokeWidth={1.7} />
            {runInfo.fileCount} file {runInfo.fileCount === 1 ? 'change' : 'changes'}
          </button>
        ) : null}
      </div>
      {showDiffModal ? (
        <DiffPreviewerModal
          runId={runInfo.runId}
          threadId={runInfo.threadId}
          workspacePath={runInfo.workspacePath}
          isLatestRun={latestRunsByThread[runInfo.threadId]?.id === runInfo.runId}
          onClose={handleCloseDiff}
        />
      ) : null}
    </>
  )
}
