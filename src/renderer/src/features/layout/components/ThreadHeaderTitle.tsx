import { Check, FolderOpen, X } from 'lucide-react'
import type { Thread } from '@renderer/app/types'

export interface ThreadHeaderTitleProps {
  activeThread: Thread | null
  draftTitle: string
  isBootstrapping: boolean
  isEditing: boolean
  messageCount: number
  onCancelRename: () => void
  onCommitRename: () => Promise<void>
  onDraftTitleChange: (nextTitle: string) => void
  onOpenThreadWorkspace: () => Promise<void>
}

function resolveThreadSubtitle(isBootstrapping: boolean, messageCount: number): string {
  if (isBootstrapping) {
    return 'Loading local workspace...'
  }

  if (messageCount > 0) {
    return `${messageCount} message${messageCount !== 1 ? 's' : ''}`
  }

  return 'No messages yet'
}

export function ThreadHeaderTitle({
  activeThread,
  draftTitle,
  isBootstrapping,
  isEditing,
  messageCount,
  onCancelRename,
  onCommitRename,
  onDraftTitleChange,
  onOpenThreadWorkspace
}: ThreadHeaderTitleProps): React.JSX.Element {
  const subtitle = resolveThreadSubtitle(isBootstrapping, messageCount)

  return (
    <div className="flex flex-col min-w-0">
      {activeThread && isEditing ? (
        <div className="no-drag flex items-center gap-1">
          <input
            autoFocus
            value={draftTitle}
            onChange={(event) => onDraftTitleChange(event.target.value)}
            onBlur={() => void onCommitRename()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void onCommitRename()
              }

              if (event.key === 'Escape') {
                onCancelRename()
              }
            }}
            className="h-8 rounded-md border px-2 text-sm font-semibold outline-none"
            style={{
              background: 'rgba(255,255,255,0.88)',
              borderColor: 'rgba(0,0,0,0.08)',
              color: '#2D2D2B',
              letterSpacing: '-0.2px'
            }}
          />
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void onCommitRename()}
            className="rounded-md p-1 no-drag transition-opacity opacity-70 hover:opacity-100"
            style={{ color: '#B56A4A' }}
            title="Save title"
          >
            <Check size={14} strokeWidth={1.8} />
          </button>
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={onCancelRename}
            className="rounded-md p-1 no-drag transition-opacity opacity-70 hover:opacity-100"
            style={{ color: '#8e8e93' }}
            title="Cancel rename"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="text-sm font-semibold truncate"
            style={{ color: '#2D2D2B', letterSpacing: '-0.2px' }}
          >
            {activeThread?.title ?? 'Start a conversation'}
          </span>
          {activeThread ? (
            <button
              onClick={() => void onOpenThreadWorkspace()}
              className="no-drag shrink-0 rounded-md p-1 transition-opacity opacity-55 hover:opacity-100"
              style={{ color: '#5b5a57' }}
              title="Open workspace in Finder"
              aria-label="Open workspace in Finder"
            >
              <FolderOpen size={14} strokeWidth={1.7} />
            </button>
          ) : null}
        </div>
      )}
      <span className="text-xs font-medium" style={{ color: '#8e8e93' }}>
        {subtitle}
      </span>
    </div>
  )
}
