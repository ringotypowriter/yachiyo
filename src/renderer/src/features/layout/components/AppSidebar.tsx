import { useState } from 'react'
import { Archive, PanelLeft, Search, Settings, SquarePen } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { ConnectionStatusIndicator } from '@renderer/features/layout/components/ConnectionStatusIndicator'
import { SidebarSearch } from '@renderer/features/search/SidebarSearch'
import { ThreadList } from '@renderer/features/threads/components/ThreadList'
import { TRAFFIC_LIGHTS_SAFE_ZONE } from '@renderer/lib/sidebarLayout'
import { theme } from '@renderer/theme/theme'

export interface AppSidebarProps {
  isOpen: boolean
  isToggleDisabled: boolean
  onToggle: () => void
  sidebarWidth: number
  toggleTitle: string
}

export function AppSidebar({
  isOpen,
  isToggleDisabled,
  onToggle,
  sidebarWidth,
  toggleTitle
}: AppSidebarProps): React.JSX.Element {
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const createNewThread = useAppStore((s) => s.createNewThread)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const setThreadListMode = useAppStore((s) => s.setThreadListMode)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const [searchOpen, setSearchOpen] = useState(false)

  return (
    <div
      aria-hidden={!isOpen}
      className="flex flex-col h-full shrink-0 overflow-hidden transition-all duration-200"
      style={{
        width: sidebarWidth,
        background: theme.background.app,
        opacity: isOpen ? 1 : 0,
        pointerEvents: isOpen ? 'auto' : 'none'
      }}
    >
      <div
        className="flex items-center drag-region shrink-0"
        style={{
          height: '52px',
          paddingLeft: `${TRAFFIC_LIGHTS_SAFE_ZONE}px`,
          paddingRight: '12px'
        }}
      >
        <div className="flex items-center gap-1 no-drag ml-auto">
          <button
            disabled={isToggleDisabled}
            onClick={onToggle}
            className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity disabled:opacity-30"
            style={{ color: theme.icon.default }}
            title={toggleTitle}
            aria-label={toggleTitle}
          >
            <PanelLeft size={16} strokeWidth={1.5} />
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            className="p-1.5 rounded-md transition-opacity"
            style={{
              color: theme.icon.default,
              opacity: searchOpen ? 0.9 : 0.5
            }}
            title="Search chats"
            aria-label="Search chats"
          >
            <Search size={15} strokeWidth={1.5} />
          </button>
          <button
            onClick={createNewThread}
            className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity"
            style={{ color: theme.icon.default }}
            title="New chat"
          >
            <SquarePen size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {searchOpen ? (
        <SidebarSearch
          onClose={() => setSearchOpen(false)}
          onSelectThread={(threadId) => {
            setActiveThread(threadId)
          }}
        />
      ) : (
        <ThreadList />
      )}

      <div className="shrink-0 px-3 py-3 no-drag">
        <div className="flex items-center">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => window.api.openSettings()}
              className="p-1.5 rounded-md opacity-40 hover:opacity-70 transition-opacity"
              style={{ color: theme.icon.default }}
              title="Settings"
              aria-label="Settings"
            >
              <Settings size={16} strokeWidth={1.5} />
            </button>
            <button
              onClick={() =>
                setThreadListMode(threadListMode === 'archived' ? 'active' : 'archived')
              }
              className="p-1.5 rounded-md transition-opacity"
              style={{
                color: threadListMode === 'archived' ? theme.text.accentStrong : theme.icon.default,
                opacity: threadListMode === 'archived' ? 0.9 : 0.4
              }}
              title={threadListMode === 'archived' ? 'Show active chats' : 'Show archived chats'}
              aria-label={
                threadListMode === 'archived' ? 'Show active chats' : 'Show archived chats'
              }
            >
              <Archive size={16} strokeWidth={1.5} />
            </button>
          </div>
          <div className="flex-1" />
          <ConnectionStatusIndicator connectionStatus={connectionStatus} />
        </div>
      </div>
    </div>
  )
}
