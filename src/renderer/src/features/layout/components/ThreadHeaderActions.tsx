import { Archive, PencilLine } from 'lucide-react'
import type { ConnectionStatus, Thread } from '@renderer/app/types'

export interface ThreadHeaderActionsProps {
  activeThread: Thread | null
  connectionStatus: ConnectionStatus
  isArchiveDisabled: boolean
  isEditingTitle: boolean
  onArchiveThread: () => Promise<void>
  onStartRename: () => void
}

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

export function ThreadHeaderActions({
  activeThread,
  connectionStatus,
  isArchiveDisabled,
  isEditingTitle,
  onArchiveThread,
  onStartRename
}: ThreadHeaderActionsProps): React.JSX.Element {
  const connectionPresentation = resolveConnectionPresentation(connectionStatus)

  return (
    <div className="flex items-center gap-2 no-drag">
      {activeThread ? (
        <>
          <button
            onClick={onStartRename}
            disabled={isEditingTitle}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-opacity disabled:opacity-40"
            style={{
              background: 'rgba(255,255,255,0.72)',
              border: '1px solid rgba(0,0,0,0.08)',
              color: '#5b5a57'
            }}
            title="Rename thread"
          >
            <PencilLine size={12} strokeWidth={1.7} />
            Rename
          </button>
          <button
            onClick={() => void onArchiveThread()}
            disabled={isArchiveDisabled}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-opacity disabled:opacity-40"
            style={{
              background: 'rgba(255,255,255,0.72)',
              border: '1px solid rgba(0,0,0,0.08)',
              color: '#7b3f39'
            }}
            title="Archive thread"
          >
            <Archive size={12} strokeWidth={1.7} />
            Archive
          </button>
        </>
      ) : null}
      <span
        className="flex items-center justify-center rounded-full"
        title={connectionPresentation.title}
        aria-label={connectionPresentation.ariaLabel}
        style={{
          width: '26px',
          height: '26px',
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
    </div>
  )
}
