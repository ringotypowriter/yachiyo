import type React from 'react'
import type { HarnessRecord } from '@renderer/app/store/useAppStore'
import { BotMessageSquare } from 'lucide-react'
import { theme } from '@renderer/theme/theme'

interface RunEventRowProps {
  harness: HarnessRecord
}

function elapsedSeconds(startedAt: string, finishedAt: string): string {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  return `${(ms / 1000).toFixed(1)}s`
}

/** Converts "delegateCodingTask · Claude Code" → { label: "Coding Task", provider: "Claude Code" } */
function parseHarnessName(name: string): { label: string; provider?: string } {
  const parts = name.split('·').map((s) => s.trim())
  const raw = parts[0]
  const provider = parts[1]

  // Split camelCase into words
  const words = raw
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  // Strip "delegate" prefix (common wrapper prefix)
  const filtered = words[0]?.toLowerCase() === 'delegate' ? words.slice(1) : words

  const label = filtered.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

  return { label: label || raw, provider }
}

export function RunEventRow({ harness }: RunEventRowProps): React.JSX.Element {
  const isRunning = harness.status === 'running'
  const isFailed = harness.status === 'failed'
  const { label, provider } = parseHarnessName(harness.name)

  const dotColor = isFailed
    ? theme.status.danger
    : isRunning
      ? theme.text.accent
      : theme.status.idle

  return (
    <div
      className="flex items-center gap-1.5 px-6 py-0.5"
      style={{ fontSize: '11px', color: theme.text.muted }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: dotColor,
          animation: isRunning ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite' : undefined
        }}
      />
      <BotMessageSquare size={11} style={{ color: theme.text.placeholder, flexShrink: 0 }} />
      <span>{label}</span>
      {provider && <span style={{ color: theme.text.placeholder }}>· {provider}</span>}
      {!isRunning && harness.finishedAt && (
        <span style={{ color: theme.text.placeholder }}>
          · {elapsedSeconds(harness.startedAt, harness.finishedAt)}
        </span>
      )}
      {isFailed && harness.error && (
        <span style={{ color: theme.text.danger }}>· {harness.error}</span>
      )}
    </div>
  )
}
