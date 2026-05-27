import type { ConnectionStatus } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'

function resolveConnectionPresentation(connectionStatus: ConnectionStatus): {
  ariaLabel: string
  indicatorColor: string
  title: string
} {
  if (connectionStatus === 'connected') {
    return {
      ariaLabel: 'Server ready',
      indicatorColor: theme.status.success,
      title: 'Server ready'
    }
  }

  return {
    ariaLabel: 'Server offline',
    indicatorColor: theme.status.danger,
    title: 'Server offline'
  }
}

export function ConnectionStatusIndicator({
  connectionStatus
}: {
  connectionStatus: ConnectionStatus
}): React.JSX.Element {
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
