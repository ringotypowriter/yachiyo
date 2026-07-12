import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer as useTanStackVirtualizer } from '@tanstack/react-virtual'
import { useShallow } from 'zustand/react/shallow'
import { Waypoints } from 'lucide-react'
import { useAppStore, type SubagentFinishedResult } from '@renderer/app/store/useAppStore'
import type { Message, RunRecord, ToolCall } from '@renderer/app/types'
import { useAppDialog, type AppConfirmOptions } from '@renderer/components/AppDialogContext'
import { theme } from '@renderer/theme/theme'
import { t } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import { useInlineCodeFileLinkSnapshot } from '@renderer/lib/markdown/inlineCodeFileLinkSnapshot'
import { useStableArray } from '@renderer/lib/useStableArray'
import { getThreadCapabilities } from '@yachiyo/shared/protocol'
import { TimelineScrollbar } from './TimelineScrollbar'
import {
  buildMessageGroups,
  getRootAssistantMessages,
  partitionToolCallsForGroups
} from '../lib/timeline/messageThreadPresentation'
import {
  buildMessageTimelineRows,
  collectInlineCodeMarkdownDocumentsFromRows,
  type MessageTimelineRow
} from '../lib/timeline/messageTimelineRows.ts'
import { useReusedTimelineRows } from '../lib/timeline/timelineRowReuse.ts'
import { buildTimelineVirtualRowStyle } from '../lib/timeline/messageTimelineRowStyle.ts'
import {
  getInitialBottomScrollDecision,
  getNativeScrollIntoViewOptions
} from '../lib/timeline/messageTimelineScroll.ts'
import { TimelineItemContent, type TimelineItemRenderContext } from './TimelineItemContent'
import { BrowserTimelineView } from './BrowserTimelineView'
import type { MessageTimelineSurface } from './TimelineSurfaceHeader'
import type { BrowserActivitySession } from '../lib/browser-activity/browserActivity'
import type { BrowserAutomationActivityBubbleState } from '@yachiyo/shared/protocol'

export type { MessageTimelineSurface } from './TimelineSurfaceHeader'

interface MessageTimelineProps {
  threadId: string | null
  recapText?: string
  activeSurface: MessageTimelineSurface
  browserSessions: BrowserActivitySession[]
  selectedBrowserSession: string | null
  browserActivityBubble?: BrowserAutomationActivityBubbleState | null
  browserViewSuspended?: boolean
  browserSessionPickerOpen?: boolean
  onSelectedBrowserSessionChange?: (session: string) => void
  onBrowserSessionPickerOpenChange?: (open: boolean) => void
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_RUNS: RunRecord[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []
const EMPTY_ACTIVE_SUBAGENT_IDS: string[] = []
const EMPTY_SUBAGENT_PROGRESS_ENTRIES: Array<{
  delegationId: string
  agentName: string
  agentType?: string
  chunk: string
}> = []
const EMPTY_SUBAGENT_FINISHED_RESULTS: SubagentFinishedResult[] = []

const useIsomorphicLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect
const useMessageTimelineVirtualizer = useTanStackVirtualizer

function estimateTimelineRowSize(item: MessageTimelineRow): number {
  switch (item.kind) {
    case 'tool':
      return 72
    case 'handoff-fold':
      return 32
    case 'handoff-summary':
      return Math.min(320, Math.ceil(item.content.length / 80) * 20 + 40)
    case 'pending-steer':
      return 120
    case 'assistant-root': {
      const msg = item.data
      const lines = Math.max(1, Math.ceil(msg.content.length / 80))
      let height = lines * 22 + 64
      if (msg.reasoning) height += 56
      return height
    }
    case 'group-user':
      return Math.max(70, Math.ceil(item.group.userMessage.content.length / 60) * 22 + 48)
    case 'group-branch-navigation':
      return 36
    case 'group-thinking':
      return item.isActive ? 120 : 56
    case 'group-memory-recall':
      return 44
    case 'group-work-summary':
      return 56
    case 'group-tool-call':
    case 'group-tool-call-group':
      return 48
    case 'group-assistant-text-block':
      return Math.max(48, Math.ceil(item.textBlock.content.length / 80) * 22 + 16)
    case 'group-plan-document':
      return 220
    case 'group-generating':
    case 'group-preparing':
      return 40
    case 'group-footer':
      return 84
    case 'group-subagent':
      return 96
  }
}

function resolveTimelineRowOffset(input: {
  key: string
  measuredSizeCache: ReadonlyMap<string, number>
  rows: readonly MessageTimelineRow[]
}): number | null {
  let offset = 0
  for (const row of input.rows) {
    if (row.key === input.key) return offset
    offset += input.measuredSizeCache.get(row.key) ?? estimateTimelineRowSize(row)
  }
  return null
}

function findScrollAnchorRowKey(input: {
  measuredSizeCache: ReadonlyMap<string, number>
  nextRows: readonly MessageTimelineRow[]
  previousRows: readonly MessageTimelineRow[]
  scrollTop: number
}): string | null {
  const nextKeys = new Set(input.nextRows.map((row) => row.key))
  let offset = 0

  for (const row of input.previousRows) {
    const size = input.measuredSizeCache.get(row.key) ?? estimateTimelineRowSize(row)
    if (offset + size >= input.scrollTop + 8 && nextKeys.has(row.key)) {
      return row.key
    }
    offset += size
  }

  return null
}

function resolveMessageTimelineWorkspacePath(
  threadWorkspacePath: string | null | undefined,
  runs: readonly RunRecord[]
): string | undefined {
  if (threadWorkspacePath) return threadWorkspacePath

  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const runWorkspacePath = runs[i]?.workspacePath
    if (runWorkspacePath) return runWorkspacePath
  }

  return undefined
}

function getDeleteMessageDialog(message: Message): AppConfirmOptions {
  if (message.role === 'user') {
    return {
      title: t('chat.timeline.deleteRequestTitle'),
      message: t('chat.timeline.deleteRequestMessage'),
      confirmLabel: t('common.delete'),
      tone: 'danger'
    }
  }

  return {
    title: t('chat.timeline.deleteBranchTitle'),
    message: t('chat.timeline.deleteBranchMessage'),
    confirmLabel: t('common.delete'),
    tone: 'danger'
  }
}

export function MessageTimeline({
  threadId,
  recapText,
  activeSurface,
  browserSessions,
  selectedBrowserSession,
  browserActivityBubble,
  browserViewSuspended = false,
  browserSessionPickerOpen = false,
  onSelectedBrowserSessionChange,
  onBrowserSessionPickerOpenChange
}: MessageTimelineProps): React.JSX.Element {
  const t = useT()
  const dialog = useAppDialog()
  const [expandedHandoffFoldKeys, setExpandedHandoffFoldKeys] = useState<Set<string>>(
    () => new Set()
  )
  const {
    thread,
    messages,
    pendingSteerEntry,
    toolCalls,
    planDocument,
    runs,
    activeRunId,
    threadIsSaving,
    subagentActive,
    activeSubagentIds,
    subagentStateById,
    subagentFinishedResultsByThread,
    subagentProgressEntries,
    retryInfo,
    cancelRunForThread,
    activeRequestMessageId,
    beginEditMessage,
    createBranch,
    deleteMessage,
    revertPendingSteer,
    acceptPlanDocument,
    rejectPlanDocument,
    retryMessage,
    selectReplyBranch,
    runPhase,
    scrollToMessageId,
    clearScrollToMessageId,
    workSummaryEnabled
  } = useAppStore(
    useShallow((state) => ({
      thread: threadId
        ? (state.threads.find((entry) => entry.id === threadId) ??
          state.externalThreads.find((entry) => entry.id === threadId) ??
          null)
        : null,
      messages: threadId ? (state.messages[threadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
      pendingSteerEntry: threadId ? (state.pendingSteerMessages[threadId] ?? null) : null,
      toolCalls: threadId ? (state.toolCalls[threadId] ?? EMPTY_TOOL_CALLS) : EMPTY_TOOL_CALLS,
      planDocument: threadId ? (state.planDocumentsByThread[threadId] ?? null) : null,
      runs: threadId ? (state.runsByThread[threadId] ?? EMPTY_RUNS) : EMPTY_RUNS,
      activeRunId: threadId ? (state.activeRunIdsByThread[threadId] ?? null) : null,
      threadIsSaving: threadId ? state.savingThreadIds.has(threadId) : false,
      subagentActive: threadId
        ? (state.subagentActiveIdsByThread[threadId]?.length ?? 0) > 0
        : false,
      activeSubagentIds: threadId
        ? (state.subagentActiveIdsByThread[threadId] ?? EMPTY_ACTIVE_SUBAGENT_IDS)
        : EMPTY_ACTIVE_SUBAGENT_IDS,
      subagentStateById: state.subagentStateById,
      subagentFinishedResultsByThread: threadId
        ? (state.subagentFinishedResultsByThread[threadId] ?? EMPTY_SUBAGENT_FINISHED_RESULTS)
        : EMPTY_SUBAGENT_FINISHED_RESULTS,
      subagentProgressEntries: threadId
        ? (state.subagentProgressTimelineByThread[threadId] ?? EMPTY_SUBAGENT_PROGRESS_ENTRIES)
        : EMPTY_SUBAGENT_PROGRESS_ENTRIES,
      retryInfo: threadId ? (state.retryInfoByThread[threadId] ?? undefined) : undefined,
      cancelRunForThread: state.cancelRunForThread,
      activeRequestMessageId: threadId
        ? (state.activeRequestMessageIdsByThread[threadId] ?? null)
        : null,
      beginEditMessage: state.beginEditMessage,
      createBranch: state.createBranch,
      deleteMessage: state.deleteMessage,
      revertPendingSteer: state.revertPendingSteer,
      acceptPlanDocument: state.acceptPlanDocument,
      rejectPlanDocument: state.rejectPlanDocument,
      retryMessage: state.retryMessage,
      selectReplyBranch: state.selectReplyBranch,
      runPhase: threadId ? (state.runPhasesByThread[threadId] ?? 'idle') : 'idle',
      scrollToMessageId: state.scrollToMessageId,
      clearScrollToMessageId: state.clearScrollToMessageId,
      workSummaryEnabled: state.config?.general?.workSummary !== false
    }))
  )
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const recapRef = useRef<HTMLDivElement>(null)
  const activeSubagents = useMemo(
    () =>
      activeSubagentIds
        .map((delegationId) => subagentStateById[delegationId])
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .map((entry) => ({
          delegationId: entry.delegationId,
          agentName: entry.agentName,
          agentType: entry.agentType,
          codeName: entry.codeName,
          prompt: entry.prompt,
          progress: entry.progress,
          startedAt: entry.startedAt,
          recentToolCalls: entry.recentToolCalls
        })),
    [activeSubagentIds, subagentStateById]
  )

  const subagentFinishedResults = useMemo(
    () => subagentFinishedResultsByThread.slice().reverse(),
    [subagentFinishedResultsByThread]
  )

  const messageGroups = useMemo(
    () =>
      thread
        ? buildMessageGroups({
            thread,
            messages,
            runs,
            runPhase,
            activeRequestMessageId
          })
        : [],
    [thread, messages, runs, runPhase, activeRequestMessageId]
  )
  const pendingSteerMessage = useMemo(
    () =>
      threadId && pendingSteerEntry
        ? {
            id: `pending-steer:${threadId}`,
            threadId,
            parentMessageId: activeRequestMessageId ?? undefined,
            role: 'user' as const,
            content: pendingSteerEntry.content,
            ...(pendingSteerEntry.images ? { images: pendingSteerEntry.images } : {}),
            status: 'streaming' as const,
            createdAt: pendingSteerEntry.createdAt
          }
        : null,
    [threadId, pendingSteerEntry, activeRequestMessageId]
  )
  const { inlineToolCalls, orphanToolCalls } = useMemo(
    () => partitionToolCallsForGroups({ groups: messageGroups, toolCalls }),
    [messageGroups, toolCalls]
  )
  const rootAssistantMessages = useMemo(() => getRootAssistantMessages(messages), [messages])
  const threadCapabilities = useMemo(
    () => (thread ? getThreadCapabilities(thread) : null),
    [thread]
  )
  const threadHasActiveRun = activeRunId !== null
  const workspacePath = resolveMessageTimelineWorkspacePath(thread?.workspacePath, runs)
  // Reuse row identities across rebuilds so the reference-equality memo on
  // TimelineItemContent keeps skipping unchanged rows during streaming.
  const timelineRows = useReusedTimelineRows(
    useMemo(
      () =>
        buildMessageTimelineRows({
          messageGroups,
          rootAssistantMessages,
          orphanToolCalls,
          pendingSteerMessage,
          inlineToolCalls,
          runs,
          activeRunId,
          activeRequestMessageId,
          subagentActive,
          contextHandoffWatermarkMessageId: thread?.contextHandoffWatermarkMessageId ?? null,
          contextHandoffSummary: thread?.contextHandoffSummary,
          expandedHandoffFoldKeys,
          workSummaryEnabled
        }),
      [
        messageGroups,
        rootAssistantMessages,
        orphanToolCalls,
        pendingSteerMessage,
        inlineToolCalls,
        runs,
        activeRunId,
        activeRequestMessageId,
        subagentActive,
        thread?.contextHandoffWatermarkMessageId,
        thread?.contextHandoffSummary,
        expandedHandoffFoldKeys,
        workSummaryEnabled
      ]
    )
  )

  // timelineRows is rebuilt every streamed frame; documents only contain
  // non-streaming content, so pin the array identity while its strings are
  // unchanged — this keeps the reference-extraction chain below fully idle
  // during streaming instead of re-running regexes over the whole thread.
  const inlineCodeMarkdownDocuments = useStableArray(
    useMemo(() => collectInlineCodeMarkdownDocumentsFromRows(timelineRows), [timelineRows])
  )
  const scrollbarMessages = useStableArray(
    useMemo<Message[]>(
      () =>
        [
          ...messageGroups.flatMap((group) => {
            const branch = group.assistantBranches[group.activeBranchIndex]
            return branch ? [group.userMessage, branch.message] : [group.userMessage]
          }),
          ...rootAssistantMessages,
          ...(pendingSteerMessage ? [pendingSteerMessage] : [])
        ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      [messageGroups, rootAssistantMessages, pendingSteerMessage]
    )
  )
  const inlineCodeFileLinks = useInlineCodeFileLinkSnapshot({
    enabled: inlineCodeMarkdownDocuments.length > 0,
    markdownDocuments: inlineCodeMarkdownDocuments,
    workspacePath
  })

  const stickToBottomRef = useRef(true)
  const prevThreadIdRef = useRef(threadId)
  const pendingThreadSwitchScrollRef = useRef<string | null>(threadId)
  const programmaticScrollUntilRef = useRef(0)
  const pendingHandoffAnchorRef = useRef<{ key: string; top: number } | null>(null)
  const timelineRowsRef = useRef(timelineRows)
  const previousTimelineRowsRef = useRef(timelineRows)
  const lastScrollTopRef = useRef(0)
  const lastTouchYRef = useRef<number | null>(null)
  const streamingScrollRafRef = useRef<number | null>(null)
  const initialBottomScrollRafRef = useRef<number | null>(null)

  const cancelInitialBottomScroll = useCallback((): void => {
    if (initialBottomScrollRafRef.current !== null) {
      cancelAnimationFrame(initialBottomScrollRafRef.current)
      initialBottomScrollRafRef.current = null
    }
  }, [])

  useIsomorphicLayoutEffect(() => {
    timelineRowsRef.current = timelineRows
  }, [timelineRows])

  useIsomorphicLayoutEffect(() => {
    if (prevThreadIdRef.current === threadId) return
    stickToBottomRef.current = true
    pendingThreadSwitchScrollRef.current = threadId
    programmaticScrollUntilRef.current = Date.now() + 500
    setExpandedHandoffFoldKeys(new Set())
    cancelInitialBottomScroll()
    prevThreadIdRef.current = threadId
  }, [threadId, cancelInitialBottomScroll])

  // Size cache keyed by timeline-item key. Survives unmount/remount so a row
  // scrolled offscreen and back doesn't snap back to a coarse estimate and
  // push later rows onto the same translateY — the original overlap bug.
  const measuredSizeCache = useRef<Map<string, number>>(new Map())

  const getScrollElement = useCallback(() => scrollContainerRef.current, [])
  // Conservative estimate: over-approximate on uncertainty. Overestimating
  // creates a transient scroll gap that self-corrects on measure; underestimating
  // causes rows to overlap until measure, and scrollToIndex lands too high.
  const estimateSize = useCallback(
    (index: number) => {
      const item = timelineRows[index]
      if (!item) return 200
      const cached = measuredSizeCache.current.get(item.key)
      if (cached != null && cached > 0) return cached
      return estimateTimelineRowSize(item)
    },
    [timelineRows]
  )
  const getItemKey = useCallback((index: number) => timelineRows[index]!.key, [timelineRows])

  const virtualizer = useMessageTimelineVirtualizer({
    count: timelineRows.length,
    getScrollElement,
    estimateSize,
    overscan: 5,
    getItemKey,
    paddingStart: 16,
    paddingEnd: 16
  })

  useIsomorphicLayoutEffect(() => {
    const previousRows = previousTimelineRowsRef.current
    if (previousRows === timelineRows) return

    const container = scrollContainerRef.current
    const pendingHandoffAnchor = pendingHandoffAnchorRef.current
    if (container && !stickToBottomRef.current) {
      if (pendingHandoffAnchor) {
        const nextOffset = resolveTimelineRowOffset({
          key: pendingHandoffAnchor.key,
          measuredSizeCache: measuredSizeCache.current,
          rows: timelineRows
        })
        if (nextOffset != null) {
          container.scrollTop = Math.max(0, nextOffset - pendingHandoffAnchor.top)
          lastScrollTopRef.current = container.scrollTop
          programmaticScrollUntilRef.current = Date.now() + 240
        }
      } else if (Date.now() >= programmaticScrollUntilRef.current) {
        const anchorKey = findScrollAnchorRowKey({
          measuredSizeCache: measuredSizeCache.current,
          nextRows: timelineRows,
          previousRows,
          scrollTop: container.scrollTop
        })

        if (anchorKey) {
          const previousOffset = resolveTimelineRowOffset({
            key: anchorKey,
            measuredSizeCache: measuredSizeCache.current,
            rows: previousRows
          })
          const nextOffset = resolveTimelineRowOffset({
            key: anchorKey,
            measuredSizeCache: measuredSizeCache.current,
            rows: timelineRows
          })

          if (previousOffset != null && nextOffset != null && previousOffset !== nextOffset) {
            container.scrollTop += nextOffset - previousOffset
            lastScrollTopRef.current = container.scrollTop
            programmaticScrollUntilRef.current = Date.now() + 120
          }
        }
      }
    }

    previousTimelineRowsRef.current = timelineRows
    if (container && pendingHandoffAnchor) {
      let retries = 14
      let stableFrames = 0
      const refineHandoffAnchor = (): void => {
        if (pendingHandoffAnchorRef.current !== pendingHandoffAnchor) return
        const currentContainer = scrollContainerRef.current
        if (!currentContainer) {
          pendingHandoffAnchorRef.current = null
          return
        }
        const marker = Array.from(
          currentContainer.querySelectorAll<HTMLElement>('[data-handoff-fold-key]')
        ).find((element) => element.dataset.handoffFoldKey === pendingHandoffAnchor.key)

        if (!marker) {
          if (retries > 0) {
            retries -= 1
            const nextOffset = resolveTimelineRowOffset({
              key: pendingHandoffAnchor.key,
              measuredSizeCache: measuredSizeCache.current,
              rows: timelineRows
            })
            if (nextOffset != null) {
              currentContainer.scrollTop = Math.max(0, nextOffset - pendingHandoffAnchor.top)
              lastScrollTopRef.current = currentContainer.scrollTop
              programmaticScrollUntilRef.current = Date.now() + 240
            }
            requestAnimationFrame(refineHandoffAnchor)
            return
          }
          pendingHandoffAnchorRef.current = null
          return
        }

        const nextTop =
          marker.getBoundingClientRect().top - currentContainer.getBoundingClientRect().top
        const delta = nextTop - pendingHandoffAnchor.top
        if (Math.abs(delta) > 0.5) {
          currentContainer.scrollTop += delta
          lastScrollTopRef.current = currentContainer.scrollTop
          programmaticScrollUntilRef.current = Date.now() + 240
          stableFrames = 0
        } else {
          stableFrames += 1
        }

        if (stableFrames < 2 && retries > 0) {
          retries -= 1
          requestAnimationFrame(refineHandoffAnchor)
          return
        }
        pendingHandoffAnchorRef.current = null
      }
      requestAnimationFrame(refineHandoffAnchor)
    }
  }, [timelineRows])
  // Sync measuredSizeCache from virtualizer's own measurements on every render.
  // getVirtualItems().size reflects the current ResizeObserver-driven size, so
  // post-mount growth (streaming text, tool group expansion, footer appearing)
  // flows into the cache and survives unmount/remount.
  useEffect(() => {
    for (const v of virtualizer.getVirtualItems()) {
      const key = String(v.key)
      if (v.size > 0 && measuredSizeCache.current.get(key) !== v.size) {
        measuredSizeCache.current.set(key, v.size)
      }
    }
  })

  const findTimelineIndex = useCallback(
    (messageId: string): number =>
      timelineRowsRef.current.findIndex(
        (item) =>
          item.key === messageId ||
          ('assistantMessageId' in item && item.assistantMessageId === messageId) ||
          ('scrollMessageId' in item && item.scrollMessageId === messageId)
      ),
    []
  )

  const handleScrollToMessage = useCallback(
    (messageId: string) => {
      const targetIndex = findTimelineIndex(messageId)
      if (targetIndex < 0) return

      // User is deliberately navigating — unpin from bottom
      stickToBottomRef.current = false
      pendingThreadSwitchScrollRef.current = null
      programmaticScrollUntilRef.current = Date.now() + 300
      cancelInitialBottomScroll()
      virtualizer.scrollToIndex(targetIndex, { align: 'center' })
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.querySelector(`[data-message-id="${messageId}"]`)
          if (el) {
            el.scrollIntoView(getNativeScrollIntoViewOptions('center'))
          }
        })
      })
    },
    [cancelInitialBottomScroll, findTimelineIndex, virtualizer]
  )

  const unpinFromBottom = useCallback((): void => {
    stickToBottomRef.current = false
  }, [])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY < -2) {
        unpinFromBottom()
      }
    }

    const handleTouchStart = (event: TouchEvent): void => {
      lastTouchYRef.current = event.touches[0]?.clientY ?? null
    }

    const handleTouchMove = (event: TouchEvent): void => {
      const nextY = event.touches[0]?.clientY
      const prevY = lastTouchYRef.current
      if (nextY != null && prevY != null && nextY - prevY > 2) {
        unpinFromBottom()
      }
      lastTouchYRef.current = nextY ?? null
    }

    const handleScroll = (): void => {
      const currentScrollTop = container.scrollTop
      const previousScrollTop = lastScrollTopRef.current
      lastScrollTopRef.current = currentScrollTop

      // Ignore scroll events caused by programmatic scroll + measurement corrections
      if (Date.now() < programmaticScrollUntilRef.current) {
        if (currentScrollTop < previousScrollTop - 8) {
          unpinFromBottom()
        }
        return
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight
      // Hysteresis: avoid rapid flipping from virtualizer measurement lag.
      if (!stickToBottomRef.current && distanceFromBottom < 50) {
        stickToBottomRef.current = true
      } else if (stickToBottomRef.current && distanceFromBottom > 200) {
        stickToBottomRef.current = false
      }

      const mask = stickToBottomRef.current
        ? 'linear-gradient(to bottom, transparent, black 24px)'
        : 'linear-gradient(to bottom, transparent, black 24px, black calc(100% - 32px), transparent)'
      container.style.maskImage = mask
      container.style.webkitMaskImage = mask
    }

    container.addEventListener('wheel', handleWheel, { passive: true })
    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: true })
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('wheel', handleWheel)
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('scroll', handleScroll)
    }
  }, [threadId, timelineRows.length, unpinFromBottom])

  const scrollToBottom = useCallback((): void => {
    if (timelineRowsRef.current.length === 0) return
    programmaticScrollUntilRef.current = Date.now() + 300
    virtualizer.scrollToIndex(timelineRowsRef.current.length - 1, { align: 'end' })
  }, [virtualizer])

  // Re-pin after the virtualizer measures newly-mounted rows. The first
  // scrollToIndex uses estimateSize, which can over/under-shoot the real
  // height of a brand-new group; after measureElement corrects the total
  // size, the browser clamps scrollTop and the bubble can land below the
  // visible area. One rAF gets us past the commit, a second past paint +
  // ResizeObserver delivery.
  const reScrollToBottomAfterMeasure = useCallback((): void => {
    if (!stickToBottomRef.current) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!stickToBottomRef.current) return
        if (timelineRowsRef.current.length === 0) return
        programmaticScrollUntilRef.current = Date.now() + 300
        virtualizer.scrollToIndex(timelineRowsRef.current.length - 1, { align: 'end' })
      })
    })
  }, [virtualizer])

  const scheduleInitialScrollToBottom = useCallback((): void => {
    cancelInitialBottomScroll()

    const runAttempt = (attempt: number): void => {
      initialBottomScrollRafRef.current = null
      if (pendingThreadSwitchScrollRef.current !== threadId) return
      if (timelineRowsRef.current.length === 0) return

      stickToBottomRef.current = true
      scrollToBottom()

      initialBottomScrollRafRef.current = requestAnimationFrame(() => {
        initialBottomScrollRafRef.current = null
        if (pendingThreadSwitchScrollRef.current !== threadId) return

        const container = scrollContainerRef.current
        const decision = getInitialBottomScrollDecision({
          attempt,
          metrics: container
            ? {
                scrollHeight: container.scrollHeight,
                clientHeight: container.clientHeight,
                scrollTop: container.scrollTop
              }
            : null
        })

        if (decision === 'done') {
          pendingThreadSwitchScrollRef.current = null
          return
        }

        initialBottomScrollRafRef.current = requestAnimationFrame(() => {
          runAttempt(attempt + 1)
        })
      })
    }

    runAttempt(0)
  }, [cancelInitialBottomScroll, scrollToBottom, threadId])

  // Scroll to bottom on thread switch.
  useIsomorphicLayoutEffect(() => {
    if (pendingThreadSwitchScrollRef.current !== threadId) return
    if (timelineRowsRef.current.length === 0) return
    scheduleInitialScrollToBottom()
  }, [threadId, timelineRows.length, scheduleInitialScrollToBottom])

  // Re-pin to bottom when the user sends a new message (activeRequestMessageId changes).
  // Without this, a user who scrolled up won't auto-scroll to their own new message.
  const prevActiveRequestRef = useRef(activeRequestMessageId)
  useEffect(() => {
    if (activeRequestMessageId && activeRequestMessageId !== prevActiveRequestRef.current) {
      stickToBottomRef.current = true
      // Immediately scroll so the user sees their own message without waiting for streaming
      scrollToBottom()
      // Re-scroll after the new row is measured; the first pass used estimateSize.
      reScrollToBottomAfterMeasure()
    }
    prevActiveRequestRef.current = activeRequestMessageId
  }, [activeRequestMessageId, scrollToBottom, reScrollToBottomAfterMeasure])

  // Keep pinned to bottom during streaming — throttled with RAF to avoid per-token thrash
  useEffect(() => {
    if (!stickToBottomRef.current || timelineRows.length === 0) return

    // Cancel any pending RAF so we always use the latest layout
    if (streamingScrollRafRef.current !== null) {
      cancelAnimationFrame(streamingScrollRafRef.current)
    }

    streamingScrollRafRef.current = requestAnimationFrame(() => {
      streamingScrollRafRef.current = null
      if (stickToBottomRef.current) {
        scrollToBottom()
      }
    })
  }, [activeRequestMessageId, messages, runPhase, toolCalls, timelineRows.length, scrollToBottom])
  useEffect(() => {
    return () => {
      cancelInitialBottomScroll()
      if (streamingScrollRafRef.current !== null) {
        cancelAnimationFrame(streamingScrollRafRef.current)
      }
    }
  }, [cancelInitialBottomScroll])

  // Scroll-to-message: bring the group into view via virtualizer, then refine to exact element
  useEffect(() => {
    if (!scrollToMessageId || timelineRows.length === 0) return
    const targetMessageId = scrollToMessageId
    clearScrollToMessageId()

    const targetIndex = findTimelineIndex(targetMessageId)
    if (targetIndex < 0) return

    pendingThreadSwitchScrollRef.current = null
    stickToBottomRef.current = false
    cancelInitialBottomScroll()
    virtualizer.scrollToIndex(targetIndex, { align: 'center' })

    // After virtualizer renders the target row, refine to the exact sub-element
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-message-id="${targetMessageId}"]`)
        if (el) {
          el.scrollIntoView(getNativeScrollIntoViewOptions('center'))
        }
      })
    })
  }, [
    scrollToMessageId,
    timelineRows.length,
    clearScrollToMessageId,
    cancelInitialBottomScroll,
    findTimelineIndex,
    virtualizer
  ])

  const handleEdit = useCallback(
    (messageId: string): void => {
      beginEditMessage(messageId)
    },
    [beginEditMessage]
  )

  const handleCreateBranch = useCallback(
    async (messageId: string): Promise<void> => {
      try {
        await createBranch(messageId)
      } catch (error) {
        await dialog.alert({
          title: error instanceof Error ? error.message : t('chat.timeline.createBranchFailed')
        })
      }
    },
    [createBranch, dialog, t]
  )

  const handleRetry = useCallback(
    async (messageId: string): Promise<void> => {
      try {
        await retryMessage(messageId)
      } catch (error) {
        await dialog.alert({
          title: error instanceof Error ? error.message : t('chat.timeline.retryFailed')
        })
      }
    },
    [dialog, retryMessage, t]
  )

  const handleDelete = useCallback(
    async (messageId: string): Promise<void> => {
      const currentMessages = useAppStore.getState().messages[threadId!] ?? []
      const target = currentMessages.find((message) => message.id === messageId)
      if (!target) {
        return
      }
      const confirmed = await dialog.confirm(getDeleteMessageDialog(target))
      if (!confirmed) return

      try {
        await deleteMessage(messageId)
      } catch (error) {
        await dialog.alert({
          title: error instanceof Error ? error.message : t('chat.timeline.deleteFailed')
        })
      }
    },
    [deleteMessage, dialog, threadId, t]
  )

  const handleSelectReplyBranch = useCallback(
    async (messageId: string): Promise<void> => {
      try {
        await selectReplyBranch(messageId)
      } catch (error) {
        await dialog.alert({
          title: error instanceof Error ? error.message : t('chat.timeline.switchBranchFailed')
        })
      }
    },
    [dialog, selectReplyBranch, t]
  )

  const handleToggleHandoffFold = useCallback(
    (foldKey: string): void => {
      stickToBottomRef.current = false
      const container = scrollContainerRef.current
      const marker = container
        ? Array.from(container.querySelectorAll<HTMLElement>('[data-handoff-fold-key]')).find(
            (element) => element.dataset.handoffFoldKey === foldKey
          )
        : null
      pendingHandoffAnchorRef.current =
        container && marker
          ? {
              key: foldKey,
              top: marker.getBoundingClientRect().top - container.getBoundingClientRect().top
            }
          : null

      setExpandedHandoffFoldKeys((current) => {
        const next = new Set(current)
        if (next.has(foldKey)) {
          next.delete(foldKey)
        } else {
          next.add(foldKey)
        }
        return next
      })
    },
    [setExpandedHandoffFoldKeys]
  )

  const isAcpThread = thread?.runtimeBinding?.kind === 'acp'

  const timelineItemContext = useMemo<TimelineItemRenderContext>(
    () => ({
      threadCapabilities,
      threadHasActiveRun,
      threadIsSaving,
      activeRequestMessageId,
      activeSubagents,
      subagentFinishedResults,
      subagentProgressEntries,
      retryInfo,
      runs,
      toolCalls,
      planDocument,
      threadId,
      workspacePath,
      inlineCodeFileLinks,
      cancelRunForThread,
      revertPendingSteer,
      acceptPlanDocument,
      rejectPlanDocument,
      onEdit: handleEdit,
      onCreateBranch: handleCreateBranch,
      onRetry: handleRetry,
      onDelete: handleDelete,
      onSelectReplyBranch: handleSelectReplyBranch,
      onToggleHandoffFold: handleToggleHandoffFold
    }),
    [
      threadCapabilities,
      threadHasActiveRun,
      threadIsSaving,
      activeRequestMessageId,
      activeSubagents,
      subagentFinishedResults,
      subagentProgressEntries,
      retryInfo,
      runs,
      toolCalls,
      planDocument,
      threadId,
      workspacePath,
      inlineCodeFileLinks,
      cancelRunForThread,
      revertPendingSteer,
      acceptPlanDocument,
      rejectPlanDocument,
      handleEdit,
      handleCreateBranch,
      handleRetry,
      handleDelete,
      handleSelectReplyBranch,
      handleToggleHandoffFold
    ]
  )

  if (!threadId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <p className="text-sm" style={{ color: theme.text.muted }}>
          {t('chat.timeline.emptyThreadPrompt')}
        </p>
      </div>
    )
  }

  const selectedActivitySession =
    browserSessions.find((session) => session.session === selectedBrowserSession) ??
    browserSessions[0]
  const effectiveSelectedBrowserSession = selectedActivitySession?.session ?? null

  return (
    <div className="flex-1 relative min-h-0 min-w-0 flex flex-col">
      <div className="message-surface-body">
        {activeSurface === 'browser' ? (
          <BrowserTimelineView
            threadId={threadId}
            sessionId={effectiveSelectedBrowserSession}
            activitySession={selectedActivitySession}
            activityBubble={browserActivityBubble}
            suspended={browserViewSuspended}
            sessions={browserSessions}
            sessionPickerOpen={browserSessionPickerOpen}
            onSelectedSessionChange={onSelectedBrowserSessionChange}
            onSessionPickerOpenChange={onBrowserSessionPickerOpenChange}
          />
        ) : timelineRows.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm" style={{ color: theme.text.placeholder }}>
              {t('chat.timeline.noMessagesYet')}
            </p>
          </div>
        ) : (
          <div className="flex-1 relative min-h-0 min-w-0">
            {!isAcpThread && (
              <TimelineScrollbar
                messages={scrollbarMessages}
                scrollContainerRef={scrollContainerRef}
                onScrollToMessage={handleScrollToMessage}
              />
            )}
            <div
              ref={scrollContainerRef}
              data-timeline-scroll
              className="h-full overflow-y-auto overflow-x-hidden yachiyo-thread-enter"
              style={{
                maskImage: 'linear-gradient(to bottom, transparent, black 24px)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 24px)',
                overflowAnchor: 'none'
              }}
            >
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  width: '100%',
                  position: 'relative'
                }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const item = timelineRows[virtualRow.index]
                  if (!item) return null

                  return (
                    <div
                      key={item.key}
                      className="message-timeline-row"
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                      style={buildTimelineVirtualRowStyle(virtualRow.start)}
                    >
                      <TimelineItemContent item={item} context={timelineItemContext} />
                    </div>
                  )
                })}
              </div>

              {recapText ? (
                <div
                  ref={recapRef}
                  className="px-6 py-3 text-xs opacity-50 italic leading-relaxed inline-flex items-start gap-1.5"
                >
                  <Waypoints size={14} className="shrink-0 mt-px" />
                  <span>
                    <strong className="not-italic">{t('chat.timeline.recap')}</strong> {recapText}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
