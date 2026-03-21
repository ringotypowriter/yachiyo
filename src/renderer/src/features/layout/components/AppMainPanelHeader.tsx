import { PanelLeft } from 'lucide-react'
import type { ConnectionStatus, Thread } from '@renderer/app/types'
import { ThreadHeaderActions } from '@renderer/features/layout/components/ThreadHeaderActions'
import { ThreadHeaderTitle } from '@renderer/features/layout/components/ThreadHeaderTitle'

export interface AppMainPanelHeaderProps {
  activeThread: Thread | null
  connectionStatus: ConnectionStatus
  draftTitle: string
  headerPaddingLeft: number
  isArchiveDisabled: boolean
  isBootstrapping: boolean
  isEditingTitle: boolean
  isSidebarToggleDisabled: boolean
  messageCount: number
  onArchiveThread: () => Promise<void>
  onCancelRename: () => void
  onCommitRename: () => Promise<void>
  onDraftTitleChange: (nextTitle: string) => void
  onOpenThreadWorkspace: () => Promise<void>
  onStartRename: () => void
  onToggleSidebar: () => void
  showSidebarToggle: boolean
  toggleSidebarTitle: string
}

export function AppMainPanelHeader({
  activeThread,
  connectionStatus,
  draftTitle,
  headerPaddingLeft,
  isArchiveDisabled,
  isBootstrapping,
  isEditingTitle,
  isSidebarToggleDisabled,
  messageCount,
  onArchiveThread,
  onCancelRename,
  onCommitRename,
  onDraftTitleChange,
  onOpenThreadWorkspace,
  onStartRename,
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
        borderBottom: '1px solid rgba(0,0,0,0.06)'
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        {showSidebarToggle ? (
          <button
            disabled={isSidebarToggleDisabled}
            onClick={onToggleSidebar}
            className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity no-drag shrink-0 disabled:opacity-30"
            style={{ color: '#2D2D2B' }}
            title={toggleSidebarTitle}
            aria-label={toggleSidebarTitle}
          >
            <PanelLeft size={16} strokeWidth={1.5} />
          </button>
        ) : null}
        <ThreadHeaderTitle
          activeThread={activeThread}
          draftTitle={draftTitle}
          isBootstrapping={isBootstrapping}
          isEditing={isEditingTitle}
          messageCount={messageCount}
          onCancelRename={onCancelRename}
          onCommitRename={onCommitRename}
          onDraftTitleChange={onDraftTitleChange}
          onOpenThreadWorkspace={onOpenThreadWorkspace}
        />
      </div>

      <ThreadHeaderActions
        activeThread={activeThread}
        connectionStatus={connectionStatus}
        isArchiveDisabled={isArchiveDisabled}
        isEditingTitle={isEditingTitle}
        onArchiveThread={onArchiveThread}
        onStartRename={onStartRename}
      />
    </div>
  )
}
