import { FolderOpen } from 'lucide-react'
import type { Thread } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'

export interface ThreadHeaderTitleProps {
  activeThread: Thread | null
  isBootstrapping: boolean
  messageCount: number
  onOpenThreadWorkspace: () => Promise<void>
  showSubtitle?: boolean
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
  onOpenThreadWorkspace,
  showSubtitle = true
}: ThreadHeaderTitleProps): React.JSX.Element {
  const subtitle = resolveThreadSubtitle(isBootstrapping, messageCount)

  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center gap-1.5 min-w-0">
        {activeThread?.icon ? (
          <span className="shrink-0 select-none leading-none" style={{ fontSize: '1em' }}>
            {activeThread.icon}
          </span>
        ) : null}
        <span
          className="text-sm font-semibold truncate"
          style={{ color: theme.text.primary, letterSpacing: '-0.2px' }}
        >
          {activeThread?.title ?? 'Start a conversation'}
        </span>
        {activeThread ? (
          <button
            onClick={() => void onOpenThreadWorkspace()}
            className="no-drag shrink-0 rounded-md p-1 transition-opacity opacity-55 hover:opacity-100"
            style={{ color: theme.text.secondary }}
            title="Open workspace in Finder"
            aria-label="Open workspace in Finder"
          >
            <FolderOpen size={14} strokeWidth={1.7} />
          </button>
        ) : null}
      </div>
      {showSubtitle ? (
        <span className="text-xs font-medium" style={{ color: theme.text.muted }}>
          {subtitle}
        </span>
      ) : null}
    </div>
  )
}
