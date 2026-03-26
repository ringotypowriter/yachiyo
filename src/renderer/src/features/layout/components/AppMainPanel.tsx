import { useEffect, useMemo, useState } from 'react'
import type { Message, Thread, ToolCall } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { ThreadFindBar } from '@renderer/features/chat/components/ThreadFindBar'
import { buildFindMatches } from '@renderer/features/chat/lib/threadFindBar'
import { Composer } from '@renderer/features/chat/components/Composer'
import { MessageTimeline } from '@renderer/features/chat/components/MessageTimeline'
import { ArchivedThreadsPage } from '@renderer/features/layout/components/ArchivedThreadsPage'
import { AppMainPanelHeader } from '@renderer/features/layout/components/AppMainPanelHeader'
import { RunInspectionPanel } from '@renderer/features/runs/components/RunInspectionPanel'
import { RunStatusStrip } from '@renderer/features/runs/components/RunStatusStrip'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import { isOpenFindBarShortcut } from '@renderer/features/layout/lib/findBarShortcut'
import { theme } from '@renderer/theme/theme'
import { isMemoryConfigured } from '../../../../../shared/yachiyo/protocol.ts'

const EMPTY: Message[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []

function getTextRanges(el: Element, query: string): Range[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const ranges: Range[] = []
  const lowerQuery = query.toLowerCase()
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? ''
    const lower = text.toLowerCase()
    let offset = 0
    while (offset < lower.length) {
      const idx = lower.indexOf(lowerQuery, offset)
      if (idx < 0) break
      const range = document.createRange()
      range.setStart(node, idx)
      range.setEnd(node, idx + query.length)
      ranges.push(range)
      offset = idx + query.length
    }
  }
  return ranges
}

export interface AppMainPanelProps {
  headerPaddingLeft: number
  isSidebarOpen: boolean
  isSidebarToggleDisabled: boolean
  showSidebarToggle: boolean
  onToggleSidebar: () => void
  toggleSidebarTitle: string
  pendingFindQuery: string | null
  onPendingFindQueryApplied: () => void
}

export function AppMainPanel({
  headerPaddingLeft,
  isSidebarOpen,
  isSidebarToggleDisabled,
  showSidebarToggle,
  onToggleSidebar,
  toggleSidebarTitle,
  pendingFindQuery,
  onPendingFindQueryApplied
}: AppMainPanelProps): React.JSX.Element {
  const archiveThread = useAppStore((s) => s.archiveThread)
  const archivedThreads = useAppStore((s) => s.archivedThreads)
  const activeArchivedThreadId = useAppStore((s) => s.activeArchivedThreadId)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const threadIsSaving = useAppStore((s) =>
    s.activeThreadId ? s.savingThreadIds.has(s.activeThreadId) : false
  )
  const cancelRunForThread = useAppStore((s) => s.cancelRunForThread)
  const deleteThread = useAppStore((s) => s.deleteThread)
  const compactThreadToAnotherThread = useAppStore((s) => s.compactThreadToAnotherThread)
  const messages = useAppStore((s) =>
    activeThreadId ? (s.messages[activeThreadId] ?? EMPTY) : EMPTY
  )
  const renameThread = useAppStore((s) => s.renameThread)
  const restoreThread = useAppStore((s) => s.restoreThread)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const threads = useAppStore((s) => s.threads)
  const isBootstrapping = useAppStore((s) => s.isBootstrapping)
  const messageCount = messages.length
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null
  const config = useAppStore((s) => s.config)
  const latestRunsByThread = useAppStore((s) => s.latestRunsByThread)
  const activeArchivedThread =
    archivedThreads.find((thread) => thread.id === activeArchivedThreadId) ?? null
  const saveThread = useAppStore((s) => s.saveThread)
  const setThreadPrivacyMode = useAppStore((s) => s.setThreadPrivacyMode)
  const starThread = useAppStore((s) => s.starThread)
  const toolCalls = useAppStore((s) =>
    activeThreadId ? (s.toolCalls[activeThreadId] ?? EMPTY_TOOL_CALLS) : EMPTY_TOOL_CALLS
  )
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)
  const [isInspectionPanelOpen, setIsInspectionPanelOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findCurrentIndex, setFindCurrentIndex] = useState(0)

  const findMatches = useMemo(
    () =>
      findOpen && findQuery.trim().length >= 2
        ? buildFindMatches(messages, toolCalls, findQuery)
        : [],
    [findOpen, findQuery, messages, toolCalls]
  )

  useEffect(() => {
    setFindCurrentIndex(0)
  }, [findMatches])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!isOpenFindBarShortcut(e) || !activeThreadId) return
      e.preventDefault()
      setFindOpen(true)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeThreadId])

  // Build CSS highlight ranges for all matched messages
  useEffect(() => {
    if (!CSS.highlights) return
    CSS.highlights.delete('yachiyo-find')
    if (!findOpen || findQuery.trim().length < 2 || findMatches.length === 0) return

    const ranges: Range[] = []
    for (const match of findMatches) {
      const el = document.querySelector(`[data-message-id="${match.messageId}"]`)
      if (el) ranges.push(...getTextRanges(el, findQuery))
    }
    if (ranges.length > 0) CSS.highlights.set('yachiyo-find', new Highlight(...ranges))

    return () => {
      CSS.highlights?.delete('yachiyo-find')
    }
  }, [findOpen, findQuery, findMatches])

  // Highlight + scroll current match
  useEffect(() => {
    if (!CSS.highlights) return
    CSS.highlights.delete('yachiyo-find-current')

    const match = findMatches[findCurrentIndex]
    if (!match) return
    const el = document.querySelector(`[data-message-id="${match.messageId}"]`)
    if (!el) return

    const ranges = getTextRanges(el, findQuery)
    if (ranges.length > 0) {
      CSS.highlights.set('yachiyo-find-current', new Highlight(...ranges))
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }

    return () => {
      CSS.highlights?.delete('yachiyo-find-current')
    }
  }, [findCurrentIndex, findMatches, findQuery])

  useEffect(() => {
    if (!pendingFindQuery) return
    setFindOpen(true)
    setFindQuery(pendingFindQuery)
    setFindCurrentIndex(0)
    onPendingFindQueryApplied()
  }, [pendingFindQuery, onPendingFindQueryApplied])

  function handleFindClose(): void {
    setFindOpen(false)
    setFindQuery('')
    setFindCurrentIndex(0)
  }
  const memoryEnabled = isMemoryConfigured(config) && !activeThread?.privacyMode

  async function handleRenameThread(thread: Thread): Promise<void> {
    if (renamingThreadId === thread.id) {
      return
    }

    setRenamingThreadId(thread.id)
    try {
      const nextTitle = window.prompt('Rename thread', thread.title)?.trim()
      if (!nextTitle || nextTitle === thread.title) {
        return
      }

      await renameThread(thread.id, nextTitle)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to rename the thread.')
    } finally {
      setRenamingThreadId(null)
    }
  }

  async function handleArchiveThread(thread: Thread): Promise<void> {
    if (!window.confirm(`Archive "${thread.title}"?`)) {
      return
    }

    try {
      await archiveThread(thread.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to archive the thread.')
    }
  }

  async function handleDeleteThread(thread: Thread): Promise<void> {
    if (latestRunsByThread[thread.id]?.status === 'running') {
      if (!window.confirm(`"${thread.title}" has an active run. Cancel the run and delete?`)) {
        return
      }
      await cancelRunForThread(thread.id)
      await deleteThread(thread.id)
      return
    }

    if (!window.confirm(`Delete "${thread.title}" permanently?`)) {
      return
    }

    try {
      await deleteThread(thread.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to delete the thread.')
    }
  }

  async function handleRestoreThread(thread: Thread): Promise<void> {
    try {
      await restoreThread(thread.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to restore the thread.')
    }
  }

  async function handleTogglePrivacyMode(): Promise<void> {
    if (!activeThread) return
    try {
      await setThreadPrivacyMode(activeThread.id, !activeThread.privacyMode)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to toggle privacy mode.')
    }
  }

  async function handleOpenThreadWorkspace(): Promise<void> {
    if (!activeThread) return

    try {
      await window.api.yachiyo.openThreadWorkspace({ threadId: activeThread.id })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to open the workspace.')
    }
  }

  function handleSelectThreadOperation(operationKey: ThreadContextOperationKey): void {
    if (!activeThread || threadIsSaving) {
      return
    }

    if (operationKey === 'rename') {
      void handleRenameThread(activeThread)
      return
    }

    if (operationKey === 'archive') {
      void handleArchiveThread(activeThread)
      return
    }

    if (operationKey === 'compact-to-another-thread') {
      void (async () => {
        try {
          await compactThreadToAnotherThread()
        } catch (error) {
          window.alert(
            error instanceof Error ? error.message : 'Failed to compact into another thread.'
          )
        }
      })()
      return
    }

    if (operationKey === 'save-thread') {
      void (async () => {
        try {
          await saveThread(activeThread.id, {
            archiveAfterSave: window.confirm(
              `Archive "${activeThread.title}" after saving it to long-term memory?`
            )
          })
        } catch (error) {
          window.alert(error instanceof Error ? error.message : 'Failed to save the thread.')
        }
      })()
      return
    }

    if (operationKey === 'star' || operationKey === 'unstar') {
      void (async () => {
        try {
          await starThread(activeThread.id, operationKey === 'star')
        } catch (error) {
          window.alert(error instanceof Error ? error.message : 'Failed to update the thread.')
        }
      })()
      return
    }

    if (operationKey === 'delete') {
      void handleDeleteThread(activeThread)
    }
  }

  const cardStyle = {
    background: theme.background.chatCard,
    borderRadius: isSidebarOpen ? 12 : 0,
    boxShadow: isSidebarOpen ? theme.shadow.card : 'none',
    transition: 'border-radius 200ms ease, box-shadow 200ms ease'
  }

  if (threadListMode === 'archived') {
    return (
      <div className="flex flex-col flex-1 h-full min-w-0 overflow-hidden" style={cardStyle}>
        <div
          className="flex items-center shrink-0 drag-region"
          style={{
            height: '48px',
            paddingLeft: `${headerPaddingLeft}px`,
            paddingRight: '20px',
            borderBottom: `1px solid ${theme.border.default}`
          }}
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
              Archived
            </div>
            <div className="text-xs font-medium" style={{ color: theme.text.muted }}>
              {archivedThreads.length} thread{archivedThreads.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
        <ArchivedThreadsPage
          activeThread={activeArchivedThread}
          onDeleteThread={handleDeleteThread}
          onRestoreThread={handleRestoreThread}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 h-full min-w-0 overflow-hidden relative" style={cardStyle}>
      {findOpen && (
        <ThreadFindBar
          matches={findMatches}
          currentIndex={findCurrentIndex}
          query={findQuery}
          onQueryChange={setFindQuery}
          onNext={() =>
            setFindCurrentIndex((i) =>
              findMatches.length === 0 ? 0 : (i + 1) % findMatches.length
            )
          }
          onPrev={() =>
            setFindCurrentIndex((i) =>
              findMatches.length === 0 ? 0 : (i - 1 + findMatches.length) % findMatches.length
            )
          }
          onClose={handleFindClose}
        />
      )}
      <AppMainPanelHeader
        activeThread={activeThread}
        headerPaddingLeft={headerPaddingLeft}
        isBootstrapping={isBootstrapping}
        isInspectionPanelOpen={isInspectionPanelOpen}
        isMemoryEnabled={memoryEnabled}
        isPrivacyMode={activeThread?.privacyMode ?? false}
        isPrivacyToggleLocked={messageCount > 0}
        isSaving={threadIsSaving}
        isSidebarToggleDisabled={isSidebarToggleDisabled}
        isStarred={!!activeThread?.starredAt}
        messageCount={messageCount}
        onOpenThreadWorkspace={handleOpenThreadWorkspace}
        onSelectThreadOperation={handleSelectThreadOperation}
        onToggleInspectionPanel={() => setIsInspectionPanelOpen((v) => !v)}
        onTogglePrivacyMode={handleTogglePrivacyMode}
        onToggleSidebar={onToggleSidebar}
        showSidebarToggle={showSidebarToggle}
        toggleSidebarTitle={toggleSidebarTitle}
      />

      <div className="flex flex-col flex-1 min-h-0 relative">
        <div className="flex flex-row flex-1 min-h-0">
          <MessageTimeline key={activeThreadId ?? 'empty'} threadId={activeThreadId} />
          {isInspectionPanelOpen ? <RunInspectionPanel threadId={activeThreadId} /> : null}
        </div>
        <RunStatusStrip />
        <Composer onSelectThreadOperation={handleSelectThreadOperation} />
        {threadIsSaving && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-auto"
            style={{
              background: 'rgba(245, 244, 240, 0.75)',
              backdropFilter: 'blur(4px)',
              WebkitBackdropFilter: 'blur(4px)'
            }}
          >
            <p className="text-sm font-medium" style={{ color: theme.text.primary }}>
              Saving to memory…
            </p>
            <p className="text-xs" style={{ color: theme.text.muted }}>
              Thread interactions are paused
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
