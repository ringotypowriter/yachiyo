import { motion, AnimatePresence } from 'framer-motion'
import { CheckCheck, PanelLeft, Search, SquarePen } from 'lucide-react'
import { tPlural } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { EssentialsBar } from '@renderer/features/essentials/components/EssentialsBar'
import { SidebarSearch } from '@renderer/features/search/SidebarSearch'
import { SidebarFilterBar } from '@renderer/features/threads/components/SidebarFilterBar'
import { ThreadList } from '@renderer/features/threads/components/ThreadList'
import { theme } from '@renderer/theme/theme'
import { Tooltip } from '@renderer/components/Tooltip'

const SIDEBAR_FILTER_BUTTON_RIGHT_OFFSET_PX = 3

export interface AppSidebarTopControlsProps {
  isSearchOpen: boolean
  isToggleDisabled: boolean
  mode: 'chat' | 'archived'
  onOpenSearch: () => void
  onToggle: () => void
  threadActivationEnabled?: boolean
  toggleTitle: string
}

export interface AppSidebarContentProps {
  isSearchOpen: boolean
  mode: 'chat' | 'archived'
  onCloseSearch: () => void
  onSearchSelect: (query: string) => void
  onThreadSelect?: (threadId: string) => void
  threadActivationEnabled?: boolean
}

export function AppSidebarTopControls({
  isSearchOpen,
  isToggleDisabled,
  mode,
  onOpenSearch,
  onToggle,
  threadActivationEnabled = true,
  toggleTitle
}: AppSidebarTopControlsProps): React.JSX.Element {
  const t = useT()
  const createNewThread = useAppStore((s) => s.createNewThread)
  const archivedThreads = useAppStore((s) => s.archivedThreads)
  const isArchivedMode = mode === 'archived'
  const hasUnreadArchived = archivedThreads.some((t) => t.archivedAt && !t.readAt)

  const handleMarkAllArchivedAsRead = async (): Promise<void> => {
    const unread = archivedThreads.filter((t) => t.archivedAt && !t.readAt)
    try {
      const updated = await Promise.all(
        unread.map((t) => window.api.yachiyo.markThreadAsRead({ threadId: t.id }))
      )
      const updatedMap = new Map(updated.map((t) => [t.id, t]))
      useAppStore.setState((state) => ({
        archivedThreads: state.archivedThreads.map((t) => updatedMap.get(t.id) ?? t)
      }))
    } catch {
      // silently fail — no need to block UI
    }
  }

  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 no-drag">
      <div className="min-w-0" style={{ paddingLeft: SIDEBAR_FILTER_BUTTON_RIGHT_OFFSET_PX }}>
        {isArchivedMode ? (
          <div className="truncate px-2 text-xs font-medium" style={{ color: theme.text.muted }}>
            {tPlural('layout.sidebar.threadCount', archivedThreads.length)}
          </div>
        ) : (
          <SidebarFilterBar />
        )}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1">
        {isArchivedMode ? (
          <>
            <Tooltip content={t('layout.sidebar.searchArchivedChats')} placement="bottom">
              <button
                onClick={onOpenSearch}
                className="p-1.5 rounded-md transition-opacity"
                style={{
                  color: theme.icon.default,
                  opacity: isSearchOpen ? 0.9 : 0.5
                }}
                aria-label={t('layout.sidebar.searchArchivedChats')}
              >
                <Search size={15} strokeWidth={1.5} />
              </button>
            </Tooltip>
            {hasUnreadArchived && (
              <Tooltip content={t('layout.sidebar.markAllAsRead')} placement="bottom">
                <button
                  onClick={() => void handleMarkAllArchivedAsRead()}
                  className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity"
                  style={{ color: theme.icon.default }}
                  aria-label={t('layout.sidebar.markAllAsRead')}
                >
                  <CheckCheck size={15} strokeWidth={1.5} />
                </button>
              </Tooltip>
            )}
          </>
        ) : (
          <>
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
            {threadActivationEnabled ? (
              <>
                <Tooltip content={t('layout.sidebar.searchChats')} placement="bottom">
                  <button
                    onClick={onOpenSearch}
                    className="p-1.5 rounded-md transition-opacity"
                    style={{
                      color: theme.icon.default,
                      opacity: isSearchOpen ? 0.9 : 0.5
                    }}
                    aria-label={t('layout.sidebar.searchChats')}
                  >
                    <Search size={15} strokeWidth={1.5} />
                  </button>
                </Tooltip>
                <Tooltip content={t('layout.sidebar.newChat')} placement="bottom">
                  <button
                    onClick={createNewThread}
                    className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity"
                    style={{ color: theme.icon.default }}
                    aria-label={t('layout.sidebar.newChat')}
                  >
                    <SquarePen size={15} strokeWidth={1.5} />
                  </button>
                </Tooltip>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

export function AppSidebarContent({
  isSearchOpen,
  mode,
  onCloseSearch,
  onSearchSelect,
  onThreadSelect,
  threadActivationEnabled = true
}: AppSidebarContentProps): React.JSX.Element {
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const setActiveArchivedThread = useAppStore((s) => s.setActiveArchivedThread)
  const isArchivedMode = mode === 'archived'

  return (
    <>
      {!isArchivedMode && threadActivationEnabled ? <EssentialsBar /> : null}
      <AnimatePresence mode="wait" initial={false}>
        {isSearchOpen && threadActivationEnabled ? (
          <motion.div
            key="search"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col flex-1 min-h-0"
          >
            <SidebarSearch
              scope={isArchivedMode ? 'archived' : 'active'}
              onClose={onCloseSearch}
              onSelectThread={(threadId, query) => {
                if (isArchivedMode) {
                  setActiveArchivedThread(threadId)
                } else {
                  setActiveThread(threadId)
                  onSearchSelect(query)
                }
              }}
              onSelectMessage={(threadId, messageId, query) => {
                if (isArchivedMode) {
                  setActiveArchivedThread(threadId, messageId)
                } else {
                  setActiveThread(threadId, messageId)
                  onSearchSelect(query)
                }
              }}
            />
          </motion.div>
        ) : (
          <motion.div
            key="thread-list"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col flex-1 min-h-0"
          >
            <ThreadList
              threadActivationEnabled={threadActivationEnabled}
              onThreadSelect={onThreadSelect}
              threadListModeOverride={isArchivedMode ? 'archived' : 'active'}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
