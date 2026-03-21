import type { ConnectionStatus } from '@renderer/app/types'

function resolveConnectionPresentation(connectionStatus: ConnectionStatus): {
  ariaLabel: string
  indicatorColor: string
  title: string
} {
  if (connectionStatus === 'connected') {
    return {
      ariaLabel: 'Server ready',
      indicatorColor: 'rgba(78, 131, 102, 0.78)',
      title: 'Server ready'
    }
  }

  return {
    ariaLabel: 'Server offline',
    indicatorColor: 'rgba(182, 92, 84, 0.76)',
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
        background: 'rgba(255,255,255,0.52)',
        border: '1px solid rgba(0,0,0,0.05)'
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
