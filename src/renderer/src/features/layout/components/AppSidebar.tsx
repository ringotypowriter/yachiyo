import { motion, AnimatePresence } from 'framer-motion'
import { PanelLeft, Search, SquarePen } from 'lucide-react'
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
  toggleTitle: string
}

export interface AppSidebarContentProps {
  isSearchOpen: boolean
  mode: 'chat' | 'archived'
  onCloseSearch: () => void
  onSearchSelect: (query: string) => void
}

export function AppSidebarTopControls({
  isSearchOpen,
  isToggleDisabled,
  mode,
  onOpenSearch,
  onToggle,
  toggleTitle
}: AppSidebarTopControlsProps): React.JSX.Element {
  const createNewThread = useAppStore((s) => s.createNewThread)
  const archivedThreads = useAppStore((s) => s.archivedThreads)
  const isArchivedMode = mode === 'archived'

  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 no-drag">
      <div className="min-w-0" style={{ paddingLeft: SIDEBAR_FILTER_BUTTON_RIGHT_OFFSET_PX }}>
        {isArchivedMode ? (
          <div className="truncate px-2 text-xs font-medium" style={{ color: theme.text.muted }}>
            {archivedThreads.length} thread{archivedThreads.length !== 1 ? 's' : ''}
          </div>
        ) : (
          <SidebarFilterBar />
        )}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1">
        {!isArchivedMode && (
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
  onSearchSelect
}: AppSidebarContentProps): React.JSX.Element {
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const isArchivedMode = mode === 'archived'

  return (
    <>
      {!isArchivedMode && <EssentialsBar />}
      <AnimatePresence mode="wait" initial={false}>
        {!isArchivedMode && isSearchOpen ? (
          <motion.div
            key="search"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col flex-1 min-h-0"
          >
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
            <ThreadList />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
