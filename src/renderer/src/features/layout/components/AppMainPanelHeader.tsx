import { PanelLeft } from 'lucide-react'
import type { Thread } from '@renderer/app/types'
import { ThreadHeaderActions } from '@renderer/features/layout/components/ThreadHeaderActions'
import { ThreadHeaderTitle } from '@renderer/features/layout/components/ThreadHeaderTitle'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import { theme } from '@renderer/theme/theme'

export interface AppMainPanelHeaderProps {
  activeThread: Thread | null
  headerPaddingLeft: number
  isBootstrapping: boolean
  isSidebarToggleDisabled: boolean
  messageCount: number
  onOpenThreadWorkspace: () => Promise<void>
  onSelectThreadOperation: (operationKey: ThreadContextOperationKey) => void
  onToggleSidebar: () => void
  showSidebarToggle: boolean
  toggleSidebarTitle: string
}

export function AppMainPanelHeader({
  activeThread,
  headerPaddingLeft,
  isBootstrapping,
  isSidebarToggleDisabled,
  messageCount,
  onOpenThreadWorkspace,
  onSelectThreadOperation,
  onToggleSidebar,
  showSidebarToggle,
  toggleSidebarTitle
}: AppMainPanelHeaderProps): React.JSX.Element {
  return (
    <div
      className="flex items-center justify-between shrink-0 drag-region"
      style={{
        height: '52px',
        paddingLeft: `${headerPaddingLeft}px`,
        paddingRight: '20px',
        borderBottom: `1px solid ${theme.border.default}`
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {showSidebarToggle ? (
          <button
            disabled={isSidebarToggleDisabled}
            onClick={onToggleSidebar}
            className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity no-drag shrink-0 disabled:opacity-30"
            style={{ color: theme.icon.default }}
            title={toggleSidebarTitle}
            aria-label={toggleSidebarTitle}
          >
            <PanelLeft size={16} strokeWidth={1.5} />
          </button>
        ) : null}
        <ThreadHeaderTitle
          activeThread={activeThread}
          isBootstrapping={isBootstrapping}
          messageCount={messageCount}
          onOpenThreadWorkspace={onOpenThreadWorkspace}
        />
      </div>

      <ThreadHeaderActions
        activeThread={activeThread}
        isRenameDisabled={false}
        onSelectOperation={onSelectThreadOperation}
      />
    </div>
  )
}
