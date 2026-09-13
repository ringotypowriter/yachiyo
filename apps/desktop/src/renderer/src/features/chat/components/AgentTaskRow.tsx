import { Square, X, Bot } from 'lucide-react'
import type { SubagentSnapshot, SubagentState } from '@yachiyo/shared/protocol'
import type { ActiveSubagentState } from '@renderer/app/store/useAppStore'
import { theme } from '@renderer/theme/theme'
import { isTaskRunning } from '../lib/taskShelf'

function formatElapsed(startedAt: string, now: number): string {
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) return ''
  const elapsedSec = Math.max(0, Math.floor((now - start) / 1000))
  if (elapsedSec < 60) return `${elapsedSec}s`
  const minutes = Math.floor(elapsedSec / 60)
  const seconds = elapsedSec % 60
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function formatState(state: SubagentState): string {
  switch (state) {
    case 'starting':
      return 'Starting'
    case 'running':
      return 'Running'
    case 'idle':
      return 'Idle'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'closed':
      return 'Closed'
    case 'interrupted':
      return 'Interrupted'
  }
}

export function AgentTaskRow({
  snapshot,
  activity,
  now,
  onCancel,
  onClose
}: {
  snapshot: SubagentSnapshot
  activity?: ActiveSubagentState
  now: number
  onCancel: () => void
  onClose: () => void
}): React.JSX.Element {
  const running = isTaskRunning(snapshot.state)
  const elapsed = formatElapsed(snapshot.startedAt, now)
  const latestTool = activity?.recentToolCalls?.[activity.recentToolCalls.length - 1]
  const progress = activity?.progress.trim()
  const recentMessage = activity?.lastMessage?.trim()
  return (
    <div className="px-3 py-2" style={{ borderBottom: `1px solid ${theme.border.subtle}` }}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
              style={{
                background: running ? theme.text.accent : theme.text.muted,
                animation: running ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite' : undefined
              }}
            />
            <Bot size={12} className="shrink-0" aria-label="Agent" />
            <span className="truncate text-xs" style={{ color: theme.text.primary }}>
              {snapshot.codeName}
            </span>
            <span className="truncate text-[10px]" style={{ color: theme.text.muted }}>
              {snapshot.agentType}
            </span>
          </div>
          <div
            className="mt-1 flex items-center gap-2 text-[10px]"
            style={{ color: theme.text.muted }}
          >
            <span>{formatState(snapshot.state)}</span>
            {elapsed ? <span className="tabular-nums">{elapsed}</span> : null}
          </div>
          {snapshot.lastOutput ? (
            <div
              className="mt-1 text-[11px] leading-snug line-clamp-2"
              style={{ color: theme.text.secondary }}
              title={snapshot.lastOutput}
            >
              {snapshot.lastOutput}
            </div>
          ) : null}
          {latestTool ? (
            <div className="mt-1 text-[10px] truncate" style={{ color: theme.text.muted }}>
              Tool: {latestTool.toolName}
              {latestTool.outputSummary ? ` · ${latestTool.outputSummary}` : ''}
            </div>
          ) : null}
          {progress ? (
            <div
              className="mt-1 text-[10px] leading-snug line-clamp-2"
              style={{ color: theme.text.secondary }}
              title={progress}
            >
              {progress}
            </div>
          ) : null}
          {recentMessage ? (
            <div
              className="mt-1 text-[10px] leading-snug line-clamp-2"
              style={{ color: theme.text.secondary }}
              title={recentMessage}
            >
              Message: {recentMessage}
            </div>
          ) : null}
        </div>
        {running ? (
          <button
            type="button"
            onClick={onCancel}
            title="Cancel agent"
            aria-label={`Cancel ${snapshot.codeName}`}
            className="p-1 rounded hover:opacity-70 shrink-0"
            style={{ color: theme.text.danger }}
          >
            <Square size={10} strokeWidth={2} fill="currentColor" />
          </button>
        ) : snapshot.state === 'idle' ? (
          <button
            type="button"
            onClick={onClose}
            title="Close agent"
            aria-label={`Close ${snapshot.codeName}`}
            className="p-1 rounded hover:opacity-70 shrink-0"
            style={{ color: theme.icon.default }}
          >
            <X size={11} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
