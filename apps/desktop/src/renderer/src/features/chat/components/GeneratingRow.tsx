import type React from 'react'
import { theme } from '@renderer/theme/theme'
import { useT } from '@yachiyo/i18n/react'
import { avatarLabels, type AvatarPhase } from '@renderer/components/avatar/avatarTypes'

export interface RetryInfo {
  attempt: number
  maxAttempts: number
  error: string
}

export function GeneratingRow({
  retryInfo,
  phase = 'loading'
}: {
  retryInfo?: RetryInfo
  phase?: AvatarPhase
}): React.JSX.Element {
  const t = useT()
  const label = retryInfo
    ? `${t('chat.timeline.retrying', { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}${retryInfo.error ? ` — ${retryInfo.error}` : ''}`
    : avatarLabels[phase]
  return (
    <div
      className="px-6 flex items-center gap-2"
      style={{ minHeight: 40, color: retryInfo ? theme.text.warning : theme.text.muted }}
    >
      <span style={{ fontSize: 11 }}>{label}</span>
    </div>
  )
}
