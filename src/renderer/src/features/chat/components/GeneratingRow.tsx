import type React from 'react'
import { theme } from '@renderer/theme/theme'

export interface RetryInfo {
  attempt: number
  maxAttempts: number
  error: string
}

export function GeneratingRow({ retryInfo }: { retryInfo?: RetryInfo }): React.JSX.Element {
  if (retryInfo) {
    return (
      <div className="px-6 py-0.5">
        <div
          className="flex items-center gap-1.5 mt-1 message-footer"
          style={{ color: theme.text.warning }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: theme.text.warning,
              display: 'inline-block',
              animation: 'yachiyo-generating-pulse 1s ease-in-out infinite'
            }}
          />
          <span>
            Retrying ({retryInfo.attempt}/{retryInfo.maxAttempts})
            {retryInfo.error ? ` — ${retryInfo.error}` : ''}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="px-6 py-0.5">
      <div
        className="flex items-center gap-1.5 mt-1 message-footer"
        style={{ color: theme.text.muted }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{
            background: theme.text.accent,
            display: 'inline-block',
            animation: 'yachiyo-generating-pulse 1s ease-in-out infinite'
          }}
        />
        <span>Generating...</span>
      </div>
    </div>
  )
}
