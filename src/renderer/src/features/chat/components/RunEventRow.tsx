import type React from 'react'
import type { HarnessRecord } from '@renderer/app/store/useAppStore'
import { theme } from '@renderer/theme/theme'

interface RunEventRowProps {
  harness: HarnessRecord
}

function elapsedSeconds(startedAt: string, finishedAt: string): string {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  return `${(ms / 1000).toFixed(1)}s`
}

export function RunEventRow({ harness }: RunEventRowProps): React.JSX.Element {
  const isRunning = harness.status === 'running'
  const isFailed = harness.status === 'failed'

  const dotColor = isFailed
    ? theme.status.danger
    : isRunning
      ? theme.text.accent
      : theme.status.idle

  return (
    <div
      className="flex items-center gap-1.5 px-6 py-0.5"
      style={{ fontSize: '11px', color: theme.text.placeholder }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: dotColor,
          animation: isRunning ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite' : undefined
        }}
      />
      <span>{harness.name}</span>
      {!isRunning && harness.finishedAt && (
        <span>· {elapsedSeconds(harness.startedAt, harness.finishedAt)}</span>
      )}
      {isFailed && harness.error && (
        <span style={{ color: theme.text.danger }}>· {harness.error}</span>
      )}
    </div>
  )
}
