import { t } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import type { ConnectionStatus } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'

// Called at render time (never cached) — the component reading this must
// call useT() so it re-renders when the locale changes.
function resolveConnectionPresentation(connectionStatus: ConnectionStatus): {
  ariaLabel: string
  indicatorColor: string
  title: string
} {
  if (connectionStatus === 'connected') {
    return {
      ariaLabel: t('layout.utilityMenu.serverReady'),
      indicatorColor: theme.status.success,
      title: t('layout.utilityMenu.serverReady')
    }
  }

  return {
    ariaLabel: t('layout.utilityMenu.serverOffline'),
    indicatorColor: theme.status.danger,
    title: t('layout.utilityMenu.serverOffline')
  }
}

export function ConnectionStatusIndicator({
  connectionStatus
}: {
  connectionStatus: ConnectionStatus
}): React.JSX.Element {
  useT()
  const connectionPresentation = resolveConnectionPresentation(connectionStatus)

  return (
    <span
      className="flex items-center justify-center rounded-full"
      title={connectionPresentation.title}
      aria-label={connectionPresentation.ariaLabel}
      style={{
        width: '24px',
        height: '24px',
        background: theme.background.surfaceSoft,
        border: `1px solid ${theme.border.subtle}`
      }}
    >
      <span
        className="rounded-full"
        style={{
          width: '8px',
          height: '8px',
          background: connectionPresentation.indicatorColor
        }}
      />
    </span>
  )
}
