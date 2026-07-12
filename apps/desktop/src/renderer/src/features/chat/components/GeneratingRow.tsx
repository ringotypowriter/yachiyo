import type React from 'react'
import { theme } from '@renderer/theme/theme'
import { useT } from '@yachiyo/i18n/react'
import {
  THINKING_SIDEBAR_PREVIEWS,
  WORKING_SIDEBAR_PREVIEWS,
  pickSidebarPlaceholder
} from '@renderer/lib/runningPlaceholders.ts'

export interface RetryInfo {
  attempt: number
  maxAttempts: number
  error: string
}

export function GeneratingRow({
  retryInfo,
  state,
  seed
}: {
  retryInfo?: RetryInfo
  state?: 'thinking' | 'working'
  seed?: string
}): React.JSX.Element {
  const t = useT()
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
            {t('chat.timeline.retrying', {
              attempt: retryInfo.attempt,
              max: retryInfo.maxAttempts
            })}
            {retryInfo.error ? ` — ${retryInfo.error}` : ''}
          </span>
        </div>
      </div>
    )
  }

  let label = t('chat.timeline.generating')
  if (state && seed) {
    label = pickSidebarPlaceholder(
      seed,
      state === 'working' ? WORKING_SIDEBAR_PREVIEWS : THINKING_SIDEBAR_PREVIEWS
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
        <span>{label}</span>
      </div>
    </div>
  )
}
