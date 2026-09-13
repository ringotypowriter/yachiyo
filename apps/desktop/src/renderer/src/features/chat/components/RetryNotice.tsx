import type React from 'react'
import { theme } from '@renderer/theme/theme'
import { useT } from '@yachiyo/i18n/react'

export interface RetryInfo {
  attempt: number
  maxAttempts: number
  error: string
}

export function RetryNotice({ retryInfo }: { retryInfo: RetryInfo }): React.JSX.Element {
  const t = useT()
  const label = `${t('chat.timeline.retrying', { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}${retryInfo.error ? ` — ${retryInfo.error}` : ''}`
  return (
    <div
      className="px-6 flex items-center gap-2"
      style={{ minHeight: 40, color: theme.text.warning }}
    >
      <span style={{ fontSize: 11 }}>{label}</span>
    </div>
  )
}
