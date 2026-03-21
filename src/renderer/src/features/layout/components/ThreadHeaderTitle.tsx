import { FolderOpen } from 'lucide-react'
import type { Thread } from '@renderer/app/types'

export interface ThreadHeaderTitleProps {
  activeThread: Thread | null
  isBootstrapping: boolean
  messageCount: number
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
  isBootstrapping,
  messageCount,
  onOpenThreadWorkspace
}: ThreadHeaderTitleProps): React.JSX.Element {
  const subtitle = resolveThreadSubtitle(isBootstrapping, messageCount)

  return (
    <div className="flex flex-col min-w-0">
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
      <span className="text-xs font-medium" style={{ color: '#8e8e93' }}>
        {subtitle}
      </span>
    </div>
  )
}
