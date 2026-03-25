import { useState } from 'react'
import type React from 'react'
import { theme } from '@renderer/theme/theme'

interface SubagentRunningIndicatorProps {
  threadId: string
  onCancel: () => void
}

export function SubagentRunningIndicator({
  onCancel
}: SubagentRunningIndicatorProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)

  function handleCancelClick(): void {
    setConfirming(true)
  }

  function handleConfirm(): void {
    setConfirming(false)
    onCancel()
  }

  function handleDismiss(): void {
    setConfirming(false)
  }

  return (
    <div className="px-6 py-0.5">
      <div className="flex items-center gap-2 mt-1 message-footer">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background: theme.text.accent,
            display: 'inline-block',
            animation: 'yachiyo-generating-pulse 1s ease-in-out infinite'
          }}
        />
        <span className="text-sm" style={{ color: theme.text.muted }}>
          Agent is working...
        </span>

        {confirming ? (
          <span className="flex items-center gap-2 ml-1">
            <span className="text-xs" style={{ color: theme.text.muted }}>
              Interrupt the agent?
            </span>
            <button
              onClick={handleConfirm}
              className="text-xs px-2 py-0.5 rounded"
              style={{
                background: theme.background.dangerSurface,
                color: theme.text.danger,
                border: `1px solid ${theme.border.danger}`
              }}
            >
              Yes, stop
            </button>
            <button
              onClick={handleDismiss}
              className="text-xs px-2 py-0.5 rounded"
              style={{
                background: theme.background.surface,
                color: theme.text.secondary,
                border: `1px solid ${theme.border.contrast}`
              }}
            >
              Keep going
            </button>
          </span>
        ) : (
          <button
            onClick={handleCancelClick}
            className="text-xs px-2 py-0.5 rounded ml-1"
            style={{
              background: theme.background.surface,
              color: theme.text.secondary,
              border: `1px solid ${theme.border.contrast}`
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
