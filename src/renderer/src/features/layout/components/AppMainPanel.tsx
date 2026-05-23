import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Message, Thread, ToolCall } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { ThreadFindBar } from '@renderer/features/chat/components/ThreadFindBar'
import { buildFindMatches } from '@renderer/features/chat/lib/threadFindBar'
import type { FindMatch } from '@renderer/features/chat/lib/threadFindBar'
import {
  useBackgroundTasksStore,
  selectThreadRunningCount
} from '@renderer/features/chat/state/useBackgroundTasksStore'
import { Composer } from '@renderer/features/chat/components/Composer'
import { ExternalThreadViewer } from '@renderer/features/chat/components/ExternalThreadViewer'
import { MessageTimeline } from '@renderer/features/chat/components/MessageTimeline'
import {
  TimelineSurfaceHeader,
  type MessageTimelineSurface
} from '@renderer/features/chat/components/TimelineSurfaceHeader'
import { ArchivedThreadsPage } from '@renderer/features/layout/components/ArchivedThreadsPage'
import { AppMainPanelHeader } from '@renderer/features/layout/components/AppMainPanelHeader'
import { RunInspectionPanel } from '@renderer/features/runs/components/RunInspectionPanel'
import { RunStatusStrip } from '@renderer/features/runs/components/RunStatusStrip'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import { isExternalThread } from '@renderer/features/threads/lib/threadVisibility'
import { isOpenFindBarShortcut } from '@renderer/features/layout/lib/findBarShortcut'
import { computeRecapDecision } from '@renderer/features/layout/lib/recapIdle'
import { deriveBrowserActivity } from '@renderer/features/chat/lib/browserActivity'
import { selectContextPromptTokens } from '@renderer/lib/contextPromptTokens'
import { MessageSquare, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { Tooltip } from '@renderer/components/Tooltip'
import { theme } from '@renderer/theme/theme'
import type {
  BrowserAutomationActivityBubbleState,
  BrowserAutomationSessionRecord
} from '../../../../../shared/yachiyo/protocol.ts'
import { isMemoryConfigured } from '../../../../../shared/yachiyo/protocol.ts'
import { isLatestRunPlanMode } from '../../../../../shared/yachiyo/planMode.ts'

const EMPTY: Message[] = []
const EMPTY_FIND_MATCHES: FindMatch[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []

function formatBrowserAction(action: string): string {
  return action.replace(/([A-Z])/g, ' $1').replace(/^./, (ch) => ch.toUpperCase())
}

function toBrowserActivityBubbleState(
  latestStep: ReturnType<typeof deriveBrowserActivity>['latestStep']
): BrowserAutomationActivityBubbleState | null {
  if (!latestStep) return null

  if (latestStep.kind === 'text') {
    return {
      label: latestStep.isStreaming ? 'Responding' : 'Latest response',
      text: latestStep.content
    }
  }

  return {
    label: 'Browser step',
    text: `${formatBrowserAction(latestStep.action)} in ${latestStep.session}${latestStep.ref ? ` · @${latestStep.ref}` : ''}`,
    ...(latestStep.title || latestStep.url
      ? { meta: `${latestStep.status} · ${latestStep.title ?? latestStep.url}` }
      : { meta: latestStep.status })
  }
}

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
  const dialog = useAppDialog()
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
  const [archiveTarget, setArchiveTarget] = useState<Thread | null>(null)
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)
  const [isInspectionPanelOpen, setIsInspectionPanelOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findCurrentIndex, setFindCurrentIndex] = useState(0)
  const [activeTimelineSurface, setActiveTimelineSurface] =
    useState<MessageTimelineSurface>('timeline')
  const [selectedBrowserSession, setSelectedBrowserSession] = useState<string | null>(null)
  const [runtimeBrowserSessions, setRuntimeBrowserSessions] = useState<
    BrowserAutomationSessionRecord[]
  >([])
  const shouldReadFindDocuments = findOpen && findQuery.trim().length >= 2
  const threadMessages = useAppStore((s) =>
    activeThreadId ? (s.messages[activeThreadId] ?? EMPTY) : EMPTY
  )
  const messages = shouldReadFindDocuments ? threadMessages : EMPTY
  const renameThread = useAppStore((s) => s.renameThread)
  const restoreThread = useAppStore((s) => s.restoreThread)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const threads = useAppStore((s) => s.threads)
  const isBootstrapping = useAppStore((s) => s.isBootstrapping)
  const messageCount = threadMessages.length
  const externalThreads = useAppStore((s) => s.externalThreads)
  const activeThread =
    threads.find((t) => t.id === activeThreadId) ??
    externalThreads.find((t) => t.id === activeThreadId) ??
    null
  const config = useAppStore((s) => s.config)
  const latestRunsByThread = useAppStore((s) => s.latestRunsByThread)
  const latestRunIsPlanMode = isLatestRunPlanMode({
    latestRun: activeThreadId ? latestRunsByThread[activeThreadId] : null,
    messages: threadMessages
  })
  const contextPromptTokens = useAppStore((s) =>
    activeThreadId
      ? selectContextPromptTokens({
          latestRun: s.latestRunsByThread[activeThreadId],
          runs: s.runsByThread[activeThreadId] ?? []
        })
      : null
  )
  const activeArchivedThread =
    archivedThreads.find((thread) => thread.id === activeArchivedThreadId) ?? null
  const runStatusesByThread = useAppStore((s) => s.runStatusesByThread)
  const hasActiveRun = activeThreadId ? runStatusesByThread[activeThreadId] === 'running' : false
  const saveThread = useAppStore((s) => s.saveThread)
  const setThreadPrivacyMode = useAppStore((s) => s.setThreadPrivacyMode)
  const starThread = useAppStore((s) => s.starThread)
  const threadToolCalls = useAppStore((s) =>
    activeThreadId ? (s.toolCalls[activeThreadId] ?? EMPTY_TOOL_CALLS) : EMPTY_TOOL_CALLS
  )
  const toolCalls = shouldReadFindDocuments ? threadToolCalls : EMPTY_TOOL_CALLS

  const browserActivity = useMemo(
    () =>
      deriveBrowserActivity({
        messages: threadMessages,
        toolCalls: threadToolCalls,
        sessions: runtimeBrowserSessions
      }),
    [runtimeBrowserSessions, threadMessages, threadToolCalls]
  )

  useEffect(() => {
    setActiveTimelineSurface('timeline')
    setSelectedBrowserSession(null)
    setRuntimeBrowserSessions([])
  }, [activeThreadId])

  useEffect(() => {
    if (!activeThreadId) {
      setRuntimeBrowserSessions([])
      return
    }

    let cancelled = false
    const refreshBrowserSessions = async (): Promise<void> => {
      try {
        const sessions = await window.api.yachiyo.listBrowserAutomationSessions({
          threadId: activeThreadId
        })
        if (!cancelled) setRuntimeBrowserSessions(sessions)
      } catch {
        if (!cancelled) setRuntimeBrowserSessions([])
      }
    }

    void refreshBrowserSessions()
    return () => {
      cancelled = true
    }
  }, [activeThreadId, threadToolCalls])

  useEffect(() => {
    if (browserActivity.sessions.length === 0) {
      if (selectedBrowserSession !== null) setSelectedBrowserSession(null)
      return
    }

    const selectedStillOpen = browserActivity.sessions.some(
      (session) => session.session === selectedBrowserSession
    )
    if (!selectedStillOpen && browserActivity.defaultSession !== selectedBrowserSession) {
      setSelectedBrowserSession(browserActivity.defaultSession)
    }
  }, [browserActivity.defaultSession, browserActivity.sessions, selectedBrowserSession])

  useEffect(() => {
    if (browserActivity.sessions.length === 0 && activeTimelineSurface !== 'timeline') {
      setActiveTimelineSurface('timeline')
    }
  }, [activeTimelineSurface, browserActivity.sessions.length])

  const headerSurfaceSwitcher =
    browserActivity.sessions.length > 0 ? (
      <TimelineSurfaceHeader
        activeSurface={activeTimelineSurface}
        browserSessions={browserActivity.sessions}
        selectedBrowserSession={selectedBrowserSession ?? browserActivity.defaultSession}
        onActiveSurfaceChange={setActiveTimelineSurface}
        onSelectedBrowserSessionChange={setSelectedBrowserSession}
      />
    ) : null

  const browserActivityBubble = useMemo(
    () =>
      activeTimelineSurface === 'browser'
        ? toBrowserActivityBubbleState(browserActivity.latestStep)
        : null,
    [activeTimelineSurface, browserActivity.latestStep]
  )

  const findMatches = useMemo(
    () =>
      shouldReadFindDocuments
        ? buildFindMatches(messages, toolCalls, findQuery)
        : EMPTY_FIND_MATCHES,
    [shouldReadFindDocuments, findQuery, messages, toolCalls]
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

  // Build CSS highlight ranges for all currently-visible matched messages
  const refreshFindHighlights = useCallback(() => {
    if (!CSS.highlights) return
    CSS.highlights.delete('yachiyo-find')
    if (!findOpen || findQuery.trim().length < 2 || findMatches.length === 0) return

    const ranges: Range[] = []
    for (const match of findMatches) {
      const el = document.querySelector(`[data-message-id="${match.messageId}"]`)
      if (el) ranges.push(...getTextRanges(el, findQuery))
    }
    if (ranges.length > 0) CSS.highlights.set('yachiyo-find', new Highlight(...ranges))
  }, [findOpen, findQuery, findMatches])

  useEffect(() => {
    refreshFindHighlights()
    return () => {
      CSS.highlights?.delete('yachiyo-find')
    }
  }, [refreshFindHighlights])

  // Refresh highlights on scroll so newly-virtualized-in matches get highlighted
  useEffect(() => {
    if (!findOpen || findMatches.length === 0) return

    const container = document.querySelector('[data-timeline-scroll]')
    if (!container) return

    let debounceId: ReturnType<typeof setTimeout> | null = null
    const handleScroll = (): void => {
      if (debounceId !== null) clearTimeout(debounceId)
      debounceId = setTimeout(refreshFindHighlights, 100)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (debounceId !== null) clearTimeout(debounceId)
    }
  }, [findOpen, findMatches.length, refreshFindHighlights])

  // Highlight + scroll current match (virtualizer-aware via store)
  const setScrollToMessageId = useAppStore((state) => state.setScrollToMessageId)
  useEffect(() => {
    if (!CSS.highlights) return
    CSS.highlights.delete('yachiyo-find-current')

    const match = findMatches[findCurrentIndex]
    if (!match) return

    // Scroll via store so the virtualizer brings the item into the DOM first
    setScrollToMessageId(match.messageId)

    // Highlight after the virtualizer renders the target
    const rafId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-message-id="${match.messageId}"]`)
        if (!el) return
        const ranges = getTextRanges(el, findQuery)
        if (ranges.length > 0) {
          CSS.highlights.set('yachiyo-find-current', new Highlight(...ranges))
        }
      })
    })

    return () => {
      cancelAnimationFrame(rafId)
      CSS.highlights?.delete('yachiyo-find-current')
    }
  }, [findCurrentIndex, findMatches, findQuery, setScrollToMessageId])

  // Hydrate background-task snapshots when switching threads so the chip can
  // catch up on tasks that started before the renderer mounted (or were left
  // running across an app restart).
  const bgRunningCount = useBackgroundTasksStore(selectThreadRunningCount(activeThreadId))
  useEffect(() => {
    if (!activeThreadId) return
    let cancelled = false
    const hydrate = (): void => {
      void window.api.yachiyo
        .listBackgroundTasks({ threadId: activeThreadId })
        .then((snapshots) => {
          if (cancelled) return
          useBackgroundTasksStore.getState().hydrate(activeThreadId, snapshots)
        })
        .catch((error: unknown) => {
          console.warn('[yachiyo] failed to hydrate background tasks', error)
        })
    }
    hydrate()
    // Re-sync periodically while there are running tasks so that dropped
    // completion events don't leave ghost "running" entries in the UI.
    const intervalId = bgRunningCount > 0 ? setInterval(hydrate, 15_000) : undefined
    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
    }
  }, [activeThreadId, bgRunningCount])

  const recapText = useAppStore((s) => {
    if (!activeThreadId) return undefined
    if (hasActiveRun || latestRunIsPlanMode) return undefined
    return s.recapByThread[activeThreadId] ?? activeThread?.recapText
  })
  const isEditingMessage = useAppStore((s) => s.editingMessage != null)
  useEffect(() => {
    if (!activeThreadId || !activeThread) return

    const decision = computeRecapDecision({
      recapEnabled: config?.chat?.recapEnabled !== false,
      isExternalThread: isExternalThread(activeThread),
      isAcpThread: activeThread.runtimeBinding?.kind === 'acp',
      hasActiveRun,
      latestRunIsPlanMode,
      isEditingMessage,
      messageCount,
      lastPromptTokens: contextPromptTokens ?? 0,
      hasExistingRecap: !!(
        useAppStore.getState().recapByThread[activeThreadId] || activeThread.recapText
      ),
      updatedAtMs: new Date(activeThread.updatedAt).getTime()
    })

    if (decision.action === 'skip') return

    const fireRecap = (): void => {
      const s = useAppStore.getState()
      const thread = s.threads.find((t) => t.id === activeThreadId)
      if (!thread) return
      if (s.config?.chat?.recapEnabled === false) return
      if (isExternalThread(thread)) return
      if (thread.runtimeBinding?.kind === 'acp') return
      if (
        isLatestRunPlanMode({
          latestRun: s.latestRunsByThread[activeThreadId],
          messages: s.messages[activeThreadId] ?? []
        })
      )
        return
      if (s.recapByThread[activeThreadId] || thread.recapText) return
      void window.api.yachiyo
        .requestRecap({ threadId: activeThreadId })
        .then((text) => {
          const state = useAppStore.getState()
          if (state.runStatusesByThread[activeThreadId] === 'running') return
          if (
            isLatestRunPlanMode({
              latestRun: state.latestRunsByThread[activeThreadId],
              messages: state.messages[activeThreadId] ?? []
            })
          )
            return
          if (text) {
            useAppStore.setState((s) => ({
              recapByThread: { ...s.recapByThread, [activeThreadId]: text }
            }))
          }
        })
        .catch(() => {})
    }

    if (decision.action === 'fire') {
      fireRecap()
      return
    }

    const timerId = setTimeout(fireRecap, decision.delayMs)
    return () => clearTimeout(timerId)
  }, [
    activeThreadId,
    activeThread,
    config?.chat?.recapEnabled,
    messageCount,
    hasActiveRun,
    latestRunIsPlanMode,
    isEditingMessage,
    contextPromptTokens
  ])

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
      const nextTitle = (
        await dialog.prompt({
          title: 'Rename thread',
          initialValue: thread.title,
          confirmLabel: 'Rename'
        })
      )?.trim()
      if (!nextTitle || nextTitle === thread.title) {
        return
      }

      await renameThread(thread.id, nextTitle)
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Failed to rename the thread.'
      })
    } finally {
      setRenamingThreadId(null)
    }
  }

  async function handleArchiveConfirm(choice: string): Promise<void> {
    if (!archiveTarget) return
    const thread = archiveTarget
    setArchiveTarget(null)

    try {
      if (choice === 'archive') {
        await archiveThread(thread.id)
      } else if (choice === 'save-and-archive') {
        if (threadIsSaving) return
        await saveThread(thread.id, { archiveAfterSave: true })
      }
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Failed to archive the thread.'
      })
    }
  }

  async function handleDeleteThread(thread: Thread): Promise<void> {
    if (latestRunsByThread[thread.id]?.status === 'running') {
      const confirmed = await dialog.confirm({
        title: `"${thread.title}" has an active run.`,
        message: 'Cancel the run and delete this thread?',
        confirmLabel: 'Delete',
        tone: 'danger'
      })
      if (!confirmed) return
      await cancelRunForThread(thread.id)
      await deleteThread(thread.id)
      return
    }

    const confirmed = await dialog.confirm({
      title: `Delete "${thread.title}" permanently?`,
      confirmLabel: 'Delete',
      tone: 'danger'
    })
    if (!confirmed) return

    try {
      await deleteThread(thread.id)
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Failed to delete the thread.'
      })
    }
  }

  async function handleRestoreThread(thread: Thread): Promise<void> {
    try {
      await restoreThread(thread.id)
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Failed to restore the thread.'
      })
    }
  }

  async function handleTogglePrivacyMode(): Promise<void> {
    if (!activeThread) return
    try {
      await setThreadPrivacyMode(activeThread.id, !activeThread.privacyMode)
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Failed to toggle privacy mode.'
      })
    }
  }

  async function handleOpenThreadWorkspace(): Promise<void> {
    if (!activeThread) return

    try {
      await window.api.yachiyo.openThreadWorkspace({ threadId: activeThread.id })
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Failed to open the workspace.'
      })
    }
  }

  async function handleOpenInEditor(): Promise<void> {
    if (!activeThread || !config?.workspace?.editorApp) return
    try {
      await window.api.yachiyo.openWorkspaceWithApp({
        threadId: activeThread.id,
        appName: config.workspace.editorApp
      })
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Failed to open in editor.'
      })
    }
  }

  async function handleOpenInTerminal(): Promise<void> {
    if (!activeThread || !config?.workspace?.terminalApp) return
    try {
      await window.api.yachiyo.openWorkspaceWithApp({
        threadId: activeThread.id,
        appName: config.workspace.terminalApp
      })
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : 'Failed to open in terminal.'
      })
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
      setArchiveTarget(activeThread)
      return
    }

    if (operationKey === 'compact-to-another-thread') {
      void (async () => {
        try {
          await compactThreadToAnotherThread()
        } catch (error) {
          await dialog.alert({
            title: error instanceof Error ? error.message : 'Failed to compact into another thread.'
          })
        }
      })()
      return
    }

    if (operationKey === 'star' || operationKey === 'unstar') {
      void (async () => {
        try {
          await starThread(activeThread.id, operationKey === 'star')
        } catch (error) {
          await dialog.alert({
            title: error instanceof Error ? error.message : 'Failed to update the thread.'
          })
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
          <div className="flex-1 min-w-0">
            {activeArchivedThread ? (
              <div className="text-sm font-semibold truncate" style={{ color: theme.text.primary }}>
                {activeArchivedThread.icon ? `${activeArchivedThread.icon} ` : ''}
                {activeArchivedThread.title}
              </div>
            ) : (
              <>
                <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
                  Archived
                </div>
                <div className="text-xs font-medium" style={{ color: theme.text.muted }}>
                  {archivedThreads.length} thread{archivedThreads.length !== 1 ? 's' : ''}
                </div>
              </>
            )}
          </div>
          {activeArchivedThread && (
            <div className="flex items-center gap-1 no-drag">
              <Tooltip content="Continue chat">
                <button
                  onClick={() => void handleRestoreThread(activeArchivedThread)}
                  className="p-1.5 rounded-md transition-opacity hover:opacity-70"
                  style={{ color: theme.icon.default }}
                >
                  <MessageSquare size={15} strokeWidth={1.5} />
                </button>
              </Tooltip>
              <Tooltip content="Delete permanently">
                <button
                  onClick={() => void handleDeleteThread(activeArchivedThread)}
                  className="p-1.5 rounded-md transition-opacity hover:opacity-70"
                  style={{ color: theme.text.danger }}
                >
                  <Trash2 size={15} strokeWidth={1.5} />
                </button>
              </Tooltip>
            </div>
          )}
        </div>
        <ArchivedThreadsPage activeThread={activeArchivedThread} />
      </div>
    )
  }

  const isExternal = activeThread != null && isExternalThread(activeThread)

  if (isExternal) {
    return (
      <div className="flex flex-col flex-1 h-full min-w-0 overflow-hidden" style={cardStyle}>
        <AppMainPanelHeader
          activeThread={activeThread}
          headerPaddingLeft={headerPaddingLeft}
          isBootstrapping={isBootstrapping}
          isInspectionPanelOpen={false}
          isPrivacyMode={false}
          isPrivacyToggleLocked={true}
          isReadOnly
          isRunning={hasActiveRun}
          isSidebarToggleDisabled={isSidebarToggleDisabled}
          isStarred={!!activeThread?.starredAt}
          messageCount={messageCount}
          onOpenThreadWorkspace={handleOpenThreadWorkspace}
          onSelectThreadOperation={handleSelectThreadOperation}
          onToggleInspectionPanel={() => {}}
          onTogglePrivacyMode={() => {}}
          onToggleSidebar={onToggleSidebar}
          showSidebarToggle={showSidebarToggle}
          toggleSidebarTitle={toggleSidebarTitle}
        />
        <ExternalThreadViewer threadId={activeThreadId} />
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 h-full min-w-0 overflow-hidden relative" style={cardStyle}>
      <AnimatePresence>
        {findOpen && (
          <motion.div
            key="find-bar"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
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
          </motion.div>
        )}
      </AnimatePresence>
      <AppMainPanelHeader
        activeThread={activeThread}
        headerPaddingLeft={headerPaddingLeft}
        isBootstrapping={isBootstrapping}
        isInspectionPanelOpen={isInspectionPanelOpen}
        isPrivacyMode={activeThread?.privacyMode ?? false}
        isPrivacyToggleLocked={messageCount > 0}
        isRunning={hasActiveRun}
        isSaving={threadIsSaving}
        isSidebarToggleDisabled={isSidebarToggleDisabled}
        isStarred={!!activeThread?.starredAt}
        centerAccessory={headerSurfaceSwitcher}
        messageCount={messageCount}
        onOpenThreadWorkspace={handleOpenThreadWorkspace}
        onOpenInEditor={config?.workspace?.editorApp ? handleOpenInEditor : undefined}
        onOpenInTerminal={config?.workspace?.terminalApp ? handleOpenInTerminal : undefined}
        onSelectThreadOperation={handleSelectThreadOperation}
        onToggleInspectionPanel={() => setIsInspectionPanelOpen((v) => !v)}
        onTogglePrivacyMode={handleTogglePrivacyMode}
        onToggleSidebar={onToggleSidebar}
        showSidebarToggle={showSidebarToggle}
        toggleSidebarTitle={toggleSidebarTitle}
      />

      <div className="flex flex-col flex-1 min-h-0 relative">
        <div className="flex flex-row flex-1 min-h-0 min-w-0">
          <MessageTimeline
            key={activeThreadId ?? 'empty'}
            threadId={activeThreadId}
            recapText={recapText}
            activeSurface={activeTimelineSurface}
            browserSessions={browserActivity.sessions}
            selectedBrowserSession={selectedBrowserSession}
            browserActivityBubble={browserActivityBubble}
          />
          <AnimatePresence initial={false}>
            {isInspectionPanelOpen && (
              <motion.div
                key="inspection-panel"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 300, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="shrink-0 overflow-hidden"
              >
                <RunInspectionPanel threadId={activeThreadId} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <RunStatusStrip />
        <div className="relative">
          <Composer onSelectThreadOperation={handleSelectThreadOperation} />
        </div>
        {threadIsSaving && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-auto"
            style={{
              background: theme.background.surfaceLight,
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
      {archiveTarget && (
        <ConfirmDialog
          title={`Archive "${archiveTarget.title}"?`}
          actions={[
            { key: 'archive', label: 'Archive', tone: 'accent' },
            ...(memoryEnabled
              ? [{ key: 'save-and-archive' as const, label: 'Save Memory & Archive' as const }]
              : []),
            { key: 'cancel', label: 'Cancel' }
          ]}
          onSelect={(key) => void handleArchiveConfirm(key)}
          onClose={() => setArchiveTarget(null)}
        />
      )}
    </div>
  )
}
