import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { t, tPlural, type AppCatalog } from '@yachiyo/i18n/index'
import type { MessageKey } from '@yachiyo/i18n/core'
import { useLocale, useT } from '@yachiyo/i18n/react'
import type { Message, Thread, ToolCall } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { ThreadFindBar } from '@renderer/features/chat/components/ThreadFindBar'
import { buildFindMatches } from '@renderer/features/chat/lib/thread-search/threadFindBar'
import type { FindMatch } from '@renderer/features/chat/lib/thread-search/threadFindBar'
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
import { WelcomeSparks } from '@renderer/features/layout/components/WelcomeSparks'
import { RunInspectionPanel } from '@renderer/features/runs/components/RunInspectionPanel'
import { RunStatusStrip } from '@renderer/features/runs/components/RunStatusStrip'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import {
  isExternalThread,
  isSyncedArchiveThread
} from '@renderer/features/threads/lib/threadVisibility'
import { isOpenFindBarShortcut } from '@renderer/features/layout/lib/findBarShortcut'
import { computeRecapDecision } from '@renderer/features/layout/lib/recapIdle'
import { resolveWelcomeState } from '@renderer/features/layout/lib/welcomeState'
import { deriveBrowserActivity } from '@renderer/features/chat/lib/browser-activity/browserActivity'
import { selectContextPromptTokens } from '@renderer/lib/contextPromptTokens'
import { Lock, MessageSquare, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { Tooltip } from '@renderer/components/Tooltip'
import { theme } from '@renderer/theme/theme'
import avatarUrl from '../../../../../../resources/branding.jpeg'
import type {
  BrowserAutomationActivityBubbleState,
  BrowserAutomationSessionRecord
} from '@yachiyo/shared/protocol'
import { isMemoryConfigured } from '@yachiyo/shared/protocol'
import { isLatestRunPlanMode } from '@yachiyo/shared/planMode'

const EMPTY: Message[] = []
const EMPTY_FIND_MATCHES: FindMatch[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []

const GREETING_KEYS = [
  'layout.welcome.greeting1',
  'layout.welcome.greeting2',
  'layout.welcome.greeting3',
  'layout.welcome.greeting4'
] as const satisfies readonly MessageKey<AppCatalog>[]

const SLOGAN_KEYS = [
  'layout.welcome.slogan1',
  'layout.welcome.slogan2',
  'layout.welcome.slogan3',
  'layout.welcome.slogan4'
] as const satisfies readonly MessageKey<AppCatalog>[]

interface WelcomeCopy {
  greeting: string
  slogan: string
}

function pickWelcomeCandidate(keys: readonly MessageKey<AppCatalog>[]): string {
  const key = keys[Math.floor(Math.random() * keys.length)] ?? keys[0]!
  return t(key)
}

// Called at render time (never cached across locales) — the caller memoizes
// the result keyed by locale so a language switch re-rolls the copy.
function buildWelcomeCopy(): WelcomeCopy {
  return {
    greeting: pickWelcomeCandidate(GREETING_KEYS),
    slogan: pickWelcomeCandidate(SLOGAN_KEYS)
  }
}

function formatBrowserAction(action: string): string {
  return action.replace(/([A-Z])/g, ' $1').replace(/^./, (ch) => ch.toUpperCase())
}

// Called at render time (never cached) — the caller must call useT()/useLocale()
// so it re-renders when the locale changes.
function toBrowserActivityBubbleState(
  latestStep: ReturnType<typeof deriveBrowserActivity>['latestStep']
): BrowserAutomationActivityBubbleState | null {
  if (!latestStep) return null

  if (latestStep.kind === 'text') {
    return {
      label: t(
        latestStep.isStreaming
          ? 'layout.browserActivity.responding'
          : 'layout.browserActivity.latestResponse'
      ),
      text: latestStep.content
    }
  }

  const stepText = t('layout.browserActivity.stepInSession', {
    action: formatBrowserAction(latestStep.action),
    session: latestStep.session
  })

  return {
    label: t('layout.browserActivity.browserStep'),
    text: latestStep.ref ? `${stepText} · @${latestStep.ref}` : stepText,
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

export interface AppMainPanelSlots {
  content: ReactNode
  contentTopControls: ReactNode
}

export interface AppMainPanelProps {
  children: (slots: AppMainPanelSlots) => React.JSX.Element
  headerPaddingLeft: number
  isSidebarToggleDisabled: boolean
  showSidebarToggle: boolean
  onToggleSidebar: () => void
  toggleSidebarTitle: string
  pendingFindQuery: string | null
  onPendingFindQueryApplied: () => void
  shortcutsEnabled: boolean
}

export function AppMainPanel({
  children,
  headerPaddingLeft,
  isSidebarToggleDisabled,
  showSidebarToggle,
  onToggleSidebar,
  toggleSidebarTitle,
  pendingFindQuery,
  onPendingFindQueryApplied,
  shortcutsEnabled
}: AppMainPanelProps): React.JSX.Element {
  const t = useT()
  const locale = useLocale()
  const dialog = useAppDialog()
  const archiveThread = useAppStore((s) => s.archiveThread)
  const archivedThreads = useAppStore((s) => s.archivedThreads)
  const activeArchivedThreadId = useAppStore((s) => s.activeArchivedThreadId)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const activeEssentialId = useAppStore((s) => s.activeEssentialId)
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
  const [isBrowserSessionMenuOpen, setIsBrowserSessionMenuOpen] = useState(false)
  const [runtimeBrowserSessions, setRuntimeBrowserSessions] = useState<
    BrowserAutomationSessionRecord[]
  >([])
  const welcomeCopyByKeyRef = useRef(new Map<string, WelcomeCopy>())
  const shouldReadFindDocuments = findOpen && findQuery.trim().length >= 2
  const threadMessages = useAppStore((s) =>
    activeThreadId ? (s.messages[activeThreadId] ?? EMPTY) : EMPTY
  )
  const activeThreadMessagesLoaded = useAppStore((s) =>
    activeThreadId === null
      ? true
      : Object.prototype.hasOwnProperty.call(s.messages, activeThreadId)
  )
  const messages = shouldReadFindDocuments ? threadMessages : EMPTY
  const renameThread = useAppStore((s) => s.renameThread)
  const restoreThread = useAppStore((s) => s.restoreThread)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const threads = useAppStore((s) => s.threads)
  const isBootstrapping = useAppStore((s) => s.isBootstrapping)
  const messageCount = threadMessages.length
  const externalThreads = useAppStore((s) => s.externalThreads)
  const activeThread =
    threads.find((t) => t.id === activeThreadId) ??
    externalThreads.find((t) => t.id === activeThreadId) ??
    null
  const activeThreadExists = activeThread !== null
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

  const candidateEssentialSourceId =
    activeEssentialId ?? activeThread?.createdFromEssentialId ?? null
  const activeEssential = useMemo(
    () =>
      candidateEssentialSourceId
        ? (config?.essentials?.find((essential) => essential.id === candidateEssentialSourceId) ??
          null)
        : null,
    [config?.essentials, candidateEssentialSourceId]
  )
  const { variant: welcomeVariant, essentialSourceId } = resolveWelcomeState({
    activeSurface: activeTimelineSurface,
    activeThreadId,
    activeThreadMessagesLoaded,
    messageCount,
    activeEssentialId,
    activeThreadCreatedFromEssentialId: activeThread?.createdFromEssentialId ?? null,
    hasActiveEssential: activeEssential !== null
  })
  const showWelcomeState = welcomeVariant !== null
  const shouldShowFindBar = findOpen && !showWelcomeState

  useEffect(() => {
    setActiveTimelineSurface('timeline')
    setSelectedBrowserSession(null)
    setIsBrowserSessionMenuOpen(false)
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
        browserSessionMenuOpen={isBrowserSessionMenuOpen}
        onActiveSurfaceChange={setActiveTimelineSurface}
        onBrowserSessionMenuOpenChange={setIsBrowserSessionMenuOpen}
      />
    ) : null

  const browserActivityBubble = useMemo(
    () =>
      activeTimelineSurface === 'browser'
        ? toBrowserActivityBubbleState(browserActivity.latestStep)
        : null,
    // locale isn't read directly here, but toBrowserActivityBubbleState() calls
    // the i18n t() function internally, so the memo must recompute on switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTimelineSurface, browserActivity.latestStep, locale]
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
      if (!shortcutsEnabled) return
      if (!isOpenFindBarShortcut(e) || !activeThreadId || showWelcomeState) return
      e.preventDefault()
      setFindOpen(true)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeThreadId, shortcutsEnabled, showWelcomeState])

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

  useEffect(() => {
    if (!activeThreadId || activeThreadMessagesLoaded || !activeThreadExists) return
    setActiveThread(activeThreadId)
  }, [activeThreadExists, activeThreadId, activeThreadMessagesLoaded, setActiveThread])

  const welcomeCopyKey = `${activeThreadId ?? 'new-thread'}:${essentialSourceId ?? 'plain'}:${locale}`
  const welcomeCopy = useMemo(() => {
    const existing = welcomeCopyByKeyRef.current.get(welcomeCopyKey)
    if (existing) return existing

    const next = buildWelcomeCopy()
    welcomeCopyByKeyRef.current.set(welcomeCopyKey, next)
    return next
  }, [welcomeCopyKey])

  useEffect(() => {
    if (!showWelcomeState || !findOpen) return
    setFindOpen(false)
    setFindQuery('')
    setFindCurrentIndex(0)
    CSS.highlights?.delete('yachiyo-find')
    CSS.highlights?.delete('yachiyo-find-current')
  }, [findOpen, showWelcomeState])

  async function handleRenameThread(thread: Thread): Promise<void> {
    if (renamingThreadId === thread.id) {
      return
    }

    setRenamingThreadId(thread.id)
    try {
      const nextTitle = (
        await dialog.prompt({
          title: t('layout.dialogs.renameThreadTitle'),
          initialValue: thread.title,
          confirmLabel: t('common.rename')
        })
      )?.trim()
      if (!nextTitle || nextTitle === thread.title) {
        return
      }

      await renameThread(thread.id, nextTitle)
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : t('threads.errors.rename')
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
        title: error instanceof Error ? error.message : t('threads.errors.archive')
      })
    }
  }

  async function handleDeleteThread(thread: Thread): Promise<void> {
    if (latestRunsByThread[thread.id]?.status === 'running') {
      const confirmed = await dialog.confirm({
        title: t('threads.confirm.activeRunTitle', { title: thread.title }),
        message: t('threads.confirm.activeRunMessage'),
        confirmLabel: t('common.delete'),
        tone: 'danger'
      })
      if (!confirmed) return
      await cancelRunForThread(thread.id)
      await deleteThread(thread.id)
      return
    }

    const confirmed = await dialog.confirm({
      title: t('threads.confirm.deleteTitle', { title: thread.title }),
      confirmLabel: t('common.delete'),
      tone: 'danger'
    })
    if (!confirmed) return

    try {
      await deleteThread(thread.id)
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : t('threads.errors.delete')
      })
    }
  }

  async function handleRestoreThread(thread: Thread): Promise<void> {
    try {
      await restoreThread(thread.id)
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : t('threads.errors.restore')
      })
    }
  }

  async function handleTogglePrivacyMode(): Promise<void> {
    if (!activeThread) return
    try {
      await setThreadPrivacyMode(activeThread.id, !activeThread.privacyMode)
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : t('layout.errors.togglePrivacy')
      })
    }
  }

  async function handleOpenThreadWorkspace(): Promise<void> {
    if (!activeThread) return

    try {
      await window.api.yachiyo.openThreadWorkspace({ threadId: activeThread.id })
    } catch (error) {
      await dialog.alert({
        title: error instanceof Error ? error.message : t('layout.errors.openWorkspace')
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
        title: error instanceof Error ? error.message : t('layout.errors.openEditor')
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
        title: error instanceof Error ? error.message : t('layout.errors.openTerminal')
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
            title: error instanceof Error ? error.message : t('threads.errors.compact')
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
            title: error instanceof Error ? error.message : t('threads.errors.update')
          })
        }
      })()
      return
    }

    if (operationKey === 'delete') {
      void handleDeleteThread(activeThread)
    }
  }

  if (threadListMode === 'archived') {
    return children({
      content: <ArchivedThreadsPage activeThread={activeArchivedThread} />,
      contentTopControls: (
        <div
          className="flex h-full min-w-0 flex-1 items-center"
          style={{
            paddingLeft: `${headerPaddingLeft}px`,
            paddingRight: '20px'
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
                  {t('layout.archived.title')}
                </div>
                <div className="text-xs font-medium" style={{ color: theme.text.muted }}>
                  {tPlural('layout.sidebar.threadCount', archivedThreads.length)}
                </div>
              </>
            )}
          </div>
          {activeArchivedThread &&
            (isSyncedArchiveThread(activeArchivedThread) ? (
              // Restore/Delete both hit the read-only guard for synced archives.
              <span
                className="no-drag inline-flex items-center"
                title={t('threads.item.readOnlySynced')}
                aria-label={t('threads.item.readOnlySynced')}
                style={{ color: theme.text.muted }}
              >
                <Lock size={14} strokeWidth={1.5} />
              </span>
            ) : (
              <div className="flex items-center gap-1 no-drag">
                <Tooltip content={t('layout.archived.continueChat')}>
                  <button
                    onClick={() => void handleRestoreThread(activeArchivedThread)}
                    className="p-1.5 rounded-md transition-opacity hover:opacity-70"
                    style={{ color: theme.icon.default }}
                  >
                    <MessageSquare size={15} strokeWidth={1.5} />
                  </button>
                </Tooltip>
                <Tooltip content={t('layout.archived.deletePermanently')}>
                  <button
                    onClick={() => void handleDeleteThread(activeArchivedThread)}
                    className="p-1.5 rounded-md transition-opacity hover:opacity-70"
                    style={{ color: theme.text.danger }}
                  >
                    <Trash2 size={15} strokeWidth={1.5} />
                  </button>
                </Tooltip>
              </div>
            ))}
        </div>
      )
    })
  }

  const isExternal = activeThread != null && isExternalThread(activeThread)
  const isSyncedArchive = activeThread != null && isSyncedArchiveThread(activeThread)

  if (isExternal) {
    return children({
      content: <ExternalThreadViewer threadId={activeThreadId} />,
      contentTopControls: (
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
      )
    })
  }

  return children({
    content: (
      <div className="flex flex-col flex-1 min-h-0 relative">
        <AnimatePresence>
          {shouldShowFindBar && (
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

        <div
          className={`work-chat-shell ${
            showWelcomeState ? 'work-chat-shell--welcome' : 'work-chat-shell--normal'
          } ${isInspectionPanelOpen ? 'work-chat-shell--inspecting' : ''}`}
        >
          <motion.div
            layout
            className="work-chat-shell__timeline-row"
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <AnimatePresence initial={false} mode="popLayout">
              {showWelcomeState ? (
                <motion.div
                  key={`empty-thread-welcome-${welcomeVariant ?? 'generic'}`}
                  className={`thread-welcome thread-welcome--${welcomeVariant ?? 'generic'}`}
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.98 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                >
                  {welcomeVariant === 'essential' && activeEssential ? (
                    <>
                      {activeEssential.iconType === 'image' ? (
                        <img
                          className="thread-welcome__essential-image"
                          src={activeEssential.icon}
                          alt={activeEssential.label ?? t('layout.welcome.essentialFallback')}
                          draggable={false}
                        />
                      ) : (
                        <span className="thread-welcome__essential-emoji">
                          {activeEssential.icon}
                        </span>
                      )}
                      <div className="thread-welcome__copy">
                        <p className="thread-welcome__eyebrow">
                          {t('layout.welcome.creationWith')}
                        </p>
                        <p className="thread-welcome__label">
                          {activeEssential.label ?? t('layout.welcome.essentialFallback')}
                        </p>
                        <p className="thread-welcome__slogan">
                          {t('layout.welcome.essentialSlogan')}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <img className="thread-welcome__avatar" src={avatarUrl} alt="Yachiyo" />
                      <div className="thread-welcome__copy">
                        <p className="thread-welcome__greeting">{welcomeCopy.greeting}</p>
                        <p className="thread-welcome__slogan">{welcomeCopy.slogan}</p>
                      </div>
                    </>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="message-timeline"
                  className="work-timeline-surface"
                  initial={{ opacity: 0, scale: 0.985 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.985 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                >
                  <MessageTimeline
                    key={activeThreadId ?? 'empty'}
                    threadId={activeThreadId}
                    recapText={recapText}
                    activeSurface={activeTimelineSurface}
                    browserSessions={browserActivity.sessions}
                    selectedBrowserSession={selectedBrowserSession}
                    browserActivityBubble={browserActivityBubble}
                    browserViewSuspended={isBrowserSessionMenuOpen}
                    browserSessionPickerOpen={isBrowserSessionMenuOpen}
                    onSelectedBrowserSessionChange={setSelectedBrowserSession}
                    onBrowserSessionPickerOpenChange={setIsBrowserSessionMenuOpen}
                  />
                </motion.div>
              )}
            </AnimatePresence>
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
          </motion.div>
          <RunStatusStrip />
          <motion.div
            layout
            className={`work-composer-slot ${
              showWelcomeState ? 'work-composer-slot--welcome' : 'work-composer-slot--normal'
            }`}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {isSyncedArchive ? (
              <div
                className="flex items-center justify-center gap-2 px-4 py-3 text-xs"
                style={{ color: theme.text.muted }}
              >
                <Lock size={13} strokeWidth={1.5} />
                <span>{t('threads.item.readOnlySynced')}</span>
              </div>
            ) : (
              <>
                <Composer
                  onSelectThreadOperation={handleSelectThreadOperation}
                  presentation={showWelcomeState ? 'compact' : 'normal'}
                />
                {welcomeVariant === 'generic' && <WelcomeSparks />}
              </>
            )}
          </motion.div>
          {threadIsSaving && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-auto"
              style={{
                background: theme.background.surfaceLight,
                backdropFilter: 'blur(4px)',
                WebkitBackdropFilter: 'blur(4px)',
                zIndex: 80
              }}
            >
              <p className="text-sm font-medium" style={{ color: theme.text.primary }}>
                {t('layout.welcome.savingToMemory')}
              </p>
              <p className="text-xs" style={{ color: theme.text.muted }}>
                {t('layout.welcome.interactionsPaused')}
              </p>
            </div>
          )}
        </div>
        {archiveTarget && (
          <ConfirmDialog
            title={t('threads.confirm.archiveTitle', { title: archiveTarget.title })}
            actions={[
              { key: 'archive', label: t('threads.actions.archive'), tone: 'accent' },
              ...(memoryEnabled
                ? [
                    {
                      key: 'save-and-archive' as const,
                      label: t('threads.actions.saveMemoryAndArchive')
                    }
                  ]
                : []),
              { key: 'cancel', label: t('common.cancel') }
            ]}
            onSelect={(key) => void handleArchiveConfirm(key)}
            onClose={() => setArchiveTarget(null)}
          />
        )}
      </div>
    ),
    contentTopControls: (
      <AppMainPanelHeader
        activeThread={activeThread}
        headerPaddingLeft={headerPaddingLeft}
        isBootstrapping={isBootstrapping}
        isInspectionPanelOpen={isInspectionPanelOpen}
        isPrivacyMode={activeThread?.privacyMode ?? false}
        isPrivacyToggleLocked={messageCount > 0}
        isReadOnly={isSyncedArchive}
        isRunning={hasActiveRun}
        isSaving={threadIsSaving}
        isSidebarToggleDisabled={isSidebarToggleDisabled}
        isStarred={!!activeThread?.starredAt}
        hideThreadActions={activeTimelineSurface === 'browser'}
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
    )
  })
}
