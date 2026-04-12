import type React from 'react'
import { useMemo } from 'react'
import { Clock, Wrench } from 'lucide-react'
import type { RunRecord } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'

interface RunStatsFooterProps {
  runs: RunRecord[]
  requestMessageId: string
  toolCallCount: number
}

/** Minimum elapsed seconds before the footer is shown. */
const ELAPSED_THRESHOLD_S = 30
/** Minimum tool call count before the footer is shown. */
const TOOL_CALL_THRESHOLD = 5

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function RunStatsFooter({
  runs,
  requestMessageId,
  toolCallCount
}: RunStatsFooterProps): React.JSX.Element | null {
  const stats = useMemo(() => {
    const run = runs.find((r) => r.requestMessageId === requestMessageId && r.completedAt != null)
    if (!run || !run.completedAt) return null

    const elapsedMs = new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()
    return { elapsedMs }
  }, [runs, requestMessageId])

  if (!stats) return null

  const showElapsed = stats.elapsedMs >= ELAPSED_THRESHOLD_S * 1000
  const showToolCalls = toolCallCount >= TOOL_CALL_THRESHOLD
  if (!showElapsed && !showToolCalls) return null

  return (
    <div
      className="message-footer message-footer--always-visible inline-flex items-center gap-2.5"
      style={{ color: theme.text.muted }}
    >
      {showElapsed ? (
        <span className="inline-flex items-center gap-1">
          <Clock size={11} strokeWidth={1.7} />
          {formatElapsed(stats.elapsedMs)}
        </span>
      ) : null}
      {showToolCalls ? (
        <span className="inline-flex items-center gap-1">
          <Wrench size={11} strokeWidth={1.7} />
          {toolCallCount} tool {toolCallCount === 1 ? 'call' : 'calls'}
        </span>
      ) : null}
    </div>
  )
}
