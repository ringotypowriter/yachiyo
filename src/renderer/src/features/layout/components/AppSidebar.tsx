import { useEffect, useState } from 'react'
import {
  Archive,
  ArrowDownCircle,
  PanelLeft,
  Radio,
  Search,
  Settings,
  SquarePen
} from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { ConnectionStatusIndicator } from '@renderer/features/layout/components/ConnectionStatusIndicator'
import { SidebarSearch } from '@renderer/features/search/SidebarSearch'
import { ThreadList } from '@renderer/features/threads/components/ThreadList'
import { TRAFFIC_LIGHTS_SAFE_ZONE } from '@renderer/lib/sidebarLayout'
import { theme, alpha } from '@renderer/theme/theme'
import { Tooltip } from '@renderer/components/Tooltip'

export interface AppSidebarProps {
  isDragging: boolean
  isOpen: boolean
  isToggleDisabled: boolean
  onToggle: () => void
  sidebarWidth: number
  toggleTitle: string
  isSearchOpen: boolean
  onOpenSearch: () => void
  onCloseSearch: () => void
  onSearchSelect: (query: string) => void
}

export function AppSidebar({
  isDragging,
  isOpen,
  isToggleDisabled,
  onToggle,
  sidebarWidth,
  toggleTitle,
  isSearchOpen,
  onOpenSearch,
  onCloseSearch,
  onSearchSelect
}: AppSidebarProps): React.JSX.Element {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [updateVersion, setUpdateVersion] = useState<string>()

  useEffect(() => {
    window.api.appUpdate.getStatus().then((s) => {
      setUpdateAvailable(s.state === 'available')
      if (s.version) setUpdateVersion(s.version)
    })
    return window.api.appUpdate.onStatus((s) => {
      setUpdateAvailable(s.state === 'available')
      if (s.version) setUpdateVersion(s.version)
    })
  }, [])

  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const createNewThread = useAppStore((s) => s.createNewThread)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const setThreadListMode = useAppStore((s) => s.setThreadListMode)
  const showExternalThreads = useAppStore((s) => s.showExternalThreads)
  const toggleShowExternalThreads = useAppStore((s) => s.toggleShowExternalThreads)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const unreadArchivedCount = useAppStore(
    (s) => s.archivedThreads.filter((t) => t.archivedAt && !t.readAt).length
  )

  return (
    <div
      aria-hidden={!isOpen}
      className="flex flex-col h-full shrink-0 overflow-hidden"
      style={{
        width: sidebarWidth,
        background: 'transparent',
        opacity: isOpen ? 1 : 0,
        pointerEvents: isOpen ? 'auto' : 'none',
        transition: isDragging ? 'none' : 'opacity 200ms, width 200ms'
      }}
    >
      <div
        className="flex items-center drag-region shrink-0"
        style={{
          height: '48px',
          paddingLeft: `${TRAFFIC_LIGHTS_SAFE_ZONE}px`,
          paddingRight: '12px'
        }}
      >
        <div className="flex items-center gap-1 no-drag ml-auto">
          <Tooltip content={toggleTitle} placement="bottom">
            <button
              disabled={isToggleDisabled}
              onClick={onToggle}
              className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity disabled:opacity-30"
              style={{ color: theme.icon.default }}
              aria-label={toggleTitle}
            >
              <PanelLeft size={16} strokeWidth={1.5} />
            </button>
          </Tooltip>
          <Tooltip content="Search chats" placement="bottom">
            <button
              onClick={onOpenSearch}
              className="p-1.5 rounded-md transition-opacity"
              style={{
                color: theme.icon.default,
                opacity: isSearchOpen ? 0.9 : 0.5
              }}
              aria-label="Search chats"
            >
              <Search size={15} strokeWidth={1.5} />
            </button>
          </Tooltip>
          <Tooltip content="New chat" placement="bottom">
            <button
              onClick={createNewThread}
              className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity"
              style={{ color: theme.icon.default }}
              aria-label="New chat"
            >
              <SquarePen size={15} strokeWidth={1.5} />
            </button>
          </Tooltip>
        </div>
      </div>

      {isSearchOpen ? (
        <SidebarSearch
          onClose={onCloseSearch}
          onSelectThread={(threadId, query) => {
            setActiveThread(threadId)
            onSearchSelect(query)
          }}
          onSelectMessage={(threadId, messageId, query) => {
            setActiveThread(threadId, messageId)
            onSearchSelect(query)
          }}
        />
      ) : (
        <ThreadList />
      )}

      <div className="shrink-0 px-3 py-3 no-drag">
        <div className="flex items-center">
          <div className="flex items-center gap-1.5">
            <Tooltip content="Settings">
              <button
                onClick={() => window.api.openSettings()}
                className="p-1.5 rounded-md opacity-40 hover:opacity-70 transition-opacity"
                style={{ color: theme.icon.default }}
                aria-label="Settings"
              >
                <Settings size={16} strokeWidth={1.5} />
              </button>
            </Tooltip>
            <Tooltip
              content={showExternalThreads ? 'Hide external threads' : 'Show external threads'}
            >
              <button
                onClick={toggleShowExternalThreads}
                className="p-1.5 rounded-md transition-opacity"
                style={{
                  color: showExternalThreads ? theme.text.accentStrong : theme.icon.default,
                  opacity: showExternalThreads ? 0.9 : 0.4
                }}
                aria-label={showExternalThreads ? 'Hide external threads' : 'Show external threads'}
              >
                <Radio size={16} strokeWidth={1.5} />
              </button>
            </Tooltip>
            <Tooltip
              content={threadListMode === 'archived' ? 'Show active chats' : 'Show archived chats'}
            >
              <button
                onClick={() =>
                  setThreadListMode(threadListMode === 'archived' ? 'active' : 'archived')
                }
                className="relative p-1.5 rounded-md transition-opacity"
                style={{
                  color:
                    threadListMode === 'archived' ? theme.text.accentStrong : theme.icon.default,
                  opacity: threadListMode === 'archived' ? 0.9 : 0.4
                }}
                aria-label={
                  threadListMode === 'archived' ? 'Show active chats' : 'Show archived chats'
                }
              >
                <Archive size={16} strokeWidth={1.5} />
                {unreadArchivedCount > 0 && threadListMode !== 'archived' && (
                  <span
                    className="absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full text-[9px] font-bold leading-none"
                    style={{
                      minWidth: 14,
                      height: 14,
                      padding: '0 3px',
                      background: theme.text.accent,
                      color: theme.text.inverse
                    }}
                  >
                    {unreadArchivedCount > 99 ? '99+' : unreadArchivedCount}
                  </span>
                )}
              </button>
            </Tooltip>
          </div>
          <div className="flex-1" />
          {updateAvailable && (
            <Tooltip content={`v${updateVersion} available`}>
              <button
                onClick={() => window.api.openSettings()}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium mr-1.5 transition-opacity hover:opacity-80"
                style={{
                  background: alpha('accent', 0.12),
                  color: theme.text.accent,
                  border: 'none',
                  cursor: 'pointer'
                }}
                aria-label="Install update"
              >
                <ArrowDownCircle size={11} strokeWidth={2} />
                Update
              </button>
            </Tooltip>
          )}
          <ConnectionStatusIndicator connectionStatus={connectionStatus} />
        </div>
      </div>
    </div>
  )
}
