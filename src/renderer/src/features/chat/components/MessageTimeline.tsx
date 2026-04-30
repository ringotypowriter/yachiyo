import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useVirtualizer as useTanStackVirtualizer } from '@tanstack/react-virtual'
import { useShallow } from 'zustand/react/shallow'
import { Waypoints } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { HarnessRecord } from '@renderer/app/store/useAppStore'
import type { Message, RunRecord, ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { getThreadCapabilities } from '../../../../../shared/yachiyo/protocol.ts'
import { TimelineScrollbar } from './TimelineScrollbar'
import {
  buildMessageGroups,
  getRootAssistantMessages,
  getTimelineMessages,
  partitionToolCallsForGroups
} from '../lib/messageThreadPresentation'
import { buildMessageTimelineRows, type MessageTimelineRow } from '../lib/messageTimelineRows.ts'
import { buildTimelineVirtualRowStyle } from '../lib/messageTimelineRowStyle.ts'
import { getInitialBottomScrollDecision } from '../lib/messageTimelineScroll.ts'
import { UserMessageBubble } from './UserMessageBubble'
import { AssistantMessageBubble } from './AssistantMessageBubble'
import { GeneratingRow } from './GeneratingRow'
import { SubagentRunningIndicator } from './SubagentRunningIndicator'
import { PreparingBubble } from './PreparingBubble'
import { RunEventRow } from './RunEventRow'
import { RunMemoryRecallRow } from './RunMemoryRecallRow'
import { ReplyBranchNavigation } from './ReplyBranchNavigation'
import { ToolCallRow } from './ToolCallRow'
import { ToolCallGroupRow } from './ToolCallGroupRow'
import { ThinkingBlock } from './ThinkingBlock'
import {
  canCreateBranch,
  canDeleteMessage,
  canEditUserMessage,
  canRetryAssistantMessage,
  canSelectReplyBranch,
  resolveRetryTargetMessageId
} from '../lib/messageActionState'
import { MessageActionBar } from './MessageActionBar'
import { RunStatsFooter } from './RunStatsFooter'

interface MessageTimelineProps {
  threadId: string | null
  recapText?: string
}

interface TimelineItemRenderContext {
  threadCapabilities: ReturnType<typeof getThreadCapabilities> | null
  threadHasActiveRun: boolean
  threadIsSaving: boolean
  activeRequestMessageId: string | null
  activeSubagents: Array<{
    delegationId: string
    agentName: string
    progress: string
  }>
  subagentProgressEntries: Array<{
    delegationId: string
    agentName: string
    chunk: string
  }>
  retryInfo?: { attempt: number; maxAttempts: number; error: string }
  runs: RunRecord[]
  toolCalls: ToolCall[]
  threadId: string | null
  workspacePath?: string
  cancelRunForThread: (threadId: string) => Promise<void>
  revertPendingSteer: () => Promise<void>
  onEdit: (messageId: string) => void
  onCreateBranch: (messageId: string) => Promise<void>
  onRetry: (messageId: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
  onSelectReplyBranch: (messageId: string) => Promise<void>
}

interface TimelineItemContentProps {
  item: MessageTimelineRow
  context: TimelineItemRenderContext
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_HARNESSES: HarnessRecord[] = []
const EMPTY_RUNS: RunRecord[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []
const EMPTY_ACTIVE_SUBAGENT_IDS: string[] = []
const EMPTY_SUBAGENT_PROGRESS_ENTRIES: Array<{
  delegationId: string
  agentName: string
  chunk: string
}> = []

const useIsomorphicLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect
const useMessageTimelineVirtualizer = useTanStackVirtualizer

function confirmDelete(message: Message): boolean {
  if (message.role === 'user') {
    return window.confirm(
      'Delete this request and every attached response branch after it in the current thread?'
    )
  }

  return window.confirm(
    'Delete this response branch and everything that continues from it in the current thread? Sibling responses will stay.'
  )
}

function renderTimelineItem(
  item: MessageTimelineRow,
  context: TimelineItemRenderContext
): React.JSX.Element | null {
  const {
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving,
    activeRequestMessageId,
    activeSubagents,
    subagentProgressEntries,
    retryInfo,
    runs,
    toolCalls,
    threadId,
    workspacePath,
    cancelRunForThread,
    revertPendingSteer,
    onEdit,
    onCreateBranch,
    onRetry,
    onDelete,
    onSelectReplyBranch
  } = context

  if (item.kind === 'harness') {
    return <RunEventRow harness={item.data} />
  }

  if (item.kind === 'pending-steer') {
    if (!threadCapabilities) return null
    return (
      <div data-message-id={item.key}>
        <UserMessageBubble
          label="Pending steer"
          pending
          message={item.data}
          threadHasActiveRun
          threadCapabilities={threadCapabilities}
          onRetry={() => undefined}
          onCreateBranch={() => undefined}
          onDelete={() => undefined}
          onRevert={() => void revertPendingSteer()}
        />
      </div>
    )
  }

  if (item.kind === 'tool') {
    return <ToolCallRow toolCall={item.data} workspacePath={workspacePath} />
  }

  if (item.kind === 'assistant-root') {
    if (item.data.status === 'streaming' && !item.data.content.trim()) {
      return (
        <div data-message-id={item.key}>
          {item.data.reasoning ? (
            <ThinkingBlock
              reasoning={item.data.reasoning}
              isActive={true}
              startedAt={item.data.createdAt}
            />
          ) : null}
          <div className="message-response-cluster">
            <div className="message-response-cluster__preparing">
              <PreparingBubble />
            </div>
          </div>
        </div>
      )
    }

    return (
      <div data-message-id={item.key}>
        {item.data.reasoning ? (
          <ThinkingBlock
            reasoning={item.data.reasoning}
            isActive={item.data.status === 'streaming'}
            startedAt={item.data.createdAt}
          />
        ) : null}
        <AssistantMessageBubble message={item.data} />
      </div>
    )
  }

  if (!threadCapabilities) return null

  const group = item.group
  const responseCount = group.assistantBranches.length
  const activeBranch =
    group.activeBranchIndex >= 0 ? group.assistantBranches[group.activeBranchIndex] : null
  const previousBranch =
    group.activeBranchIndex > 0 ? group.assistantBranches[group.activeBranchIndex - 1] : null
  const nextBranch =
    group.activeBranchIndex >= 0 && group.activeBranchIndex < responseCount - 1
      ? group.assistantBranches[group.activeBranchIndex + 1]
      : null
  const retryTargetMessageId = resolveRetryTargetMessageId({
    userMessageId: group.userMessage.id,
    ...(activeBranch ? { activeAssistantMessage: activeBranch.message } : {})
  })
  const canBranchMessages = canCreateBranch({
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving
  })
  const canEditMessages = canEditUserMessage({
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving
  })
  const canDeleteMessages = canDeleteMessage({
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving
  })
  const canSwitchReplyBranches = canSelectReplyBranch({
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving
  })
  const isActiveGroup = item.requestMessageId === activeRequestMessageId
  const groupRetryInfo = isActiveGroup ? retryInfo : undefined
  const cancelSubagent =
    isActiveGroup && activeSubagents.length === 1 && threadId
      ? () => void cancelRunForThread(threadId)
      : undefined

  if (item.kind === 'group-user') {
    return (
      <div data-message-id={group.userMessage.id}>
        <UserMessageBubble
          message={group.userMessage}
          threadHasActiveRun={threadHasActiveRun}
          threadCapabilities={threadCapabilities}
          threadIsSaving={threadIsSaving}
          onEdit={canEditMessages ? () => onEdit(group.userMessage.id) : undefined}
          onRetry={threadCapabilities.canRetry ? () => onRetry(retryTargetMessageId) : undefined}
          onCreateBranch={
            canBranchMessages ? () => onCreateBranch(group.userMessage.id) : undefined
          }
          onDelete={canDeleteMessages ? () => onDelete(group.userMessage.id) : undefined}
        />
      </div>
    )
  }

  if (item.kind === 'group-branch-navigation') {
    return (
      <div className="px-6 py-0.5">
        <ReplyBranchNavigation
          replyCount={responseCount}
          canSelectPreviousReply={canSwitchReplyBranches && Boolean(previousBranch)}
          canSelectNextReply={canSwitchReplyBranches && Boolean(nextBranch)}
          onSelectPreviousReply={
            canSwitchReplyBranches && previousBranch
              ? () => void onSelectReplyBranch(previousBranch.message.id)
              : undefined
          }
          onSelectNextReply={
            canSwitchReplyBranches && nextBranch
              ? () => void onSelectReplyBranch(nextBranch.message.id)
              : undefined
          }
        />
      </div>
    )
  }

  if (item.kind === 'group-thinking') {
    return (
      <div {...(item.scrollMessageId ? { 'data-message-id': item.scrollMessageId } : {})}>
        <ThinkingBlock
          reasoning={item.assistantMessage.reasoning ?? ''}
          isActive={item.assistantMessage.status === 'streaming'}
          startedAt={item.assistantMessage.createdAt}
        />
      </div>
    )
  }

  if (item.kind === 'group-memory-recall') {
    return <RunMemoryRecallRow entries={item.entries} recallDecision={item.recallDecision} />
  }

  if (item.kind === 'group-tool-call') {
    return <ToolCallRow toolCall={item.toolCall} workspacePath={workspacePath} />
  }

  if (item.kind === 'group-tool-call-group') {
    return (
      <ToolCallGroupRow
        group={item.toolGroup}
        toolCalls={item.toolCalls}
        workspacePath={workspacePath}
      />
    )
  }

  if (item.kind === 'group-assistant-text-block') {
    return (
      <div className="message-response-cluster" data-message-id={item.assistantMessage.id}>
        <AssistantMessageBubble
          message={item.assistantMessage}
          contentOverride={item.textBlock.content}
          showFooter={false}
          suppressGeneratingLabel={
            item.hasRunningToolCall || item.assistantMessage.status === 'streaming'
          }
          pauseStreaming={!item.isStreaming}
          showCaret={item.isStreaming}
          compactBottomSpacing={item.compactBottomSpacing}
        />
      </div>
    )
  }

  if (item.kind === 'group-generating') {
    return <GeneratingRow retryInfo={groupRetryInfo} />
  }

  if (item.kind === 'group-preparing') {
    if (groupRetryInfo) {
      return <GeneratingRow retryInfo={groupRetryInfo} />
    }

    return (
      <div className="message-response-cluster">
        <div className="message-response-cluster__preparing">
          <PreparingBubble />
        </div>
      </div>
    )
  }

  if (item.kind === 'group-footer') {
    return (
      <div className="message-bubble-group px-6 py-1 flex flex-col gap-0.5">
        {item.assistantMessage.status === 'stopped' ? (
          <div className="message-footer message-footer--always-visible">Stopped</div>
        ) : item.assistantMessage.status === 'failed' ? (
          <div
            className="message-footer message-footer--always-visible"
            style={{ color: theme.text.danger }}
          >
            {item.failedRunError ? `Failed: ${item.failedRunError}` : 'Failed to generate'}
          </div>
        ) : null}
        {item.savedMemoryCount > 0 ? (
          <div
            className="message-footer message-footer--always-visible inline-flex items-center gap-1"
            style={{ color: theme.text.accent }}
          >
            {item.savedMemoryCount === 1
              ? 'Memory saved'
              : `${item.savedMemoryCount} memories saved`}
          </div>
        ) : null}
        <RunStatsFooter
          runs={runs}
          toolCalls={toolCalls}
          requestMessageId={item.requestMessageId}
        />
        <MessageActionBar
          align="start"
          content={item.assistantMessage.content}
          canRetry={canRetryAssistantMessage({
            messageStatus: item.assistantMessage.status,
            threadCapabilities,
            threadHasActiveRun,
            threadIsSaving
          })}
          onRetry={
            threadCapabilities.canRetry ? () => onRetry(item.assistantMessage.id) : undefined
          }
          onCreateBranch={
            canBranchMessages ? () => onCreateBranch(item.assistantMessage.id) : undefined
          }
          onDelete={canDeleteMessages ? () => onDelete(item.assistantMessage.id) : undefined}
        />
      </div>
    )
  }

  if (item.kind === 'group-subagent') {
    return (
      <SubagentRunningIndicator
        agents={activeSubagents}
        progressEntries={subagentProgressEntries}
        onCancel={cancelSubagent}
      />
    )
  }

  return null
}

function TimelineItemContentBase({
  item,
  context
}: TimelineItemContentProps): React.JSX.Element | null {
  return renderTimelineItem(item, context)
}

const TimelineItemContent = memo(
  TimelineItemContentBase,
  (prev, next) => prev.item === next.item && prev.context === next.context
)

export function MessageTimeline({ threadId, recapText }: MessageTimelineProps): React.JSX.Element {
  const {
    thread,
    messages,
    harnessEvents,
    pendingSteerEntry,
    toolCalls,
    runs,
    activeRunId,
    threadIsSaving,
    subagentActive,
    activeSubagentIds,
    subagentStateById,
    subagentProgressEntries,
    retryInfo,
    cancelRunForThread,
    activeRequestMessageId,
    beginEditMessage,
    createBranch,
    deleteMessage,
    revertPendingSteer,
    retryMessage,
    selectReplyBranch,
    runPhase,
    scrollToMessageId,
    clearScrollToMessageId,
    activeEssentialId,
    essentials
  } = useAppStore(
    useShallow((state) => ({
      thread: threadId
        ? (state.threads.find((entry) => entry.id === threadId) ??
          state.externalThreads.find((entry) => entry.id === threadId) ??
          null)
        : null,
      messages: threadId ? (state.messages[threadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
      harnessEvents: threadId
        ? (state.harnessEvents[threadId] ?? EMPTY_HARNESSES)
        : EMPTY_HARNESSES,
      pendingSteerEntry: threadId ? (state.pendingSteerMessages[threadId] ?? null) : null,
      toolCalls: threadId ? (state.toolCalls[threadId] ?? EMPTY_TOOL_CALLS) : EMPTY_TOOL_CALLS,
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
      retryMessage: state.retryMessage,
      selectReplyBranch: state.selectReplyBranch,
      runPhase: threadId ? (state.runPhasesByThread[threadId] ?? 'idle') : 'idle',
      scrollToMessageId: state.scrollToMessageId,
      clearScrollToMessageId: state.clearScrollToMessageId,
      activeEssentialId: state.activeEssentialId,
      essentials: state.config?.essentials
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
          progress: entry.progress
        })),
    [activeSubagentIds, subagentStateById]
  )

  const timelineMessages = useMemo(
    () => (thread ? getTimelineMessages({ thread, messages }) : messages),
    [thread, messages]
  )

  const messageGroups = useMemo(
    () =>
      thread
        ? buildMessageGroups({
            thread,
            messages: timelineMessages,
            runPhase,
            activeRequestMessageId
          })
        : [],
    [thread, timelineMessages, runPhase, activeRequestMessageId]
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
  const rootAssistantMessages = useMemo(
    () => getRootAssistantMessages(timelineMessages),
    [timelineMessages]
  )
  const threadCapabilities = useMemo(
    () => (thread ? getThreadCapabilities(thread) : null),
    [thread]
  )
  const threadHasActiveRun = activeRunId !== null
  const timelineRows = useMemo(
    () =>
      buildMessageTimelineRows({
        messageGroups,
        rootAssistantMessages,
        harnessEvents,
        orphanToolCalls,
        pendingSteerMessage,
        inlineToolCalls,
        runs,
        activeRunId,
        activeRequestMessageId,
        subagentActive
      }),
    [
      messageGroups,
      rootAssistantMessages,
      harnessEvents,
      orphanToolCalls,
      pendingSteerMessage,
      inlineToolCalls,
      runs,
      activeRunId,
      activeRequestMessageId,
      subagentActive
    ]
  )

  const visibleMessages = useMemo<Message[]>(
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

  const stickToBottomRef = useRef(true)
  const prevThreadIdRef = useRef(threadId)
  const pendingThreadSwitchScrollRef = useRef<string | null>(threadId)
  const programmaticScrollUntilRef = useRef(0)
  const timelineRowsRef = useRef(timelineRows)
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
      switch (item.kind) {
        case 'harness':
          return 56
        case 'tool':
          return 72
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
          return item.assistantMessage.status === 'streaming' ? 120 : 56
        case 'group-memory-recall':
          return 44
        case 'group-tool-call':
        case 'group-tool-call-group':
          return 48
        case 'group-assistant-text-block':
          return Math.max(48, Math.ceil(item.textBlock.content.length / 80) * 22 + 16)
        case 'group-generating':
        case 'group-preparing':
          return 40
        case 'group-footer':
          return 84
        case 'group-subagent':
          return 96
        default:
          return 240
      }
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
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        })
      })
    },
    [cancelInitialBottomScroll, findTimelineIndex, virtualizer]
  )

  // Track user scroll to detect manual scroll-away
  useEffect(() => {
    if (recapText && recapRef.current && stickToBottomRef.current) {
      recapRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [recapText])

  const unpinFromBottom = useCallback((): void => {
    stickToBottomRef.current = false
    pendingThreadSwitchScrollRef.current = null
    programmaticScrollUntilRef.current = 0
    cancelInitialBottomScroll()
    if (streamingScrollRafRef.current !== null) {
      cancelAnimationFrame(streamingScrollRafRef.current)
      streamingScrollRafRef.current = null
    }
  }, [cancelInitialBottomScroll])

  // Deps include threadId and timeline.length so the listener reattaches
  // when the scroll container first appears (empty thread → first message)
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    lastScrollTopRef.current = container.scrollTop

    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) {
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
  }, [
    activeRequestMessageId,
    harnessEvents,
    messages,
    runPhase,
    toolCalls,
    timelineRows.length,
    scrollToBottom
  ])
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
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
        window.alert(error instanceof Error ? error.message : 'Failed to create a branch.')
      }
    },
    [createBranch]
  )

  const handleRetry = useCallback(
    async (messageId: string): Promise<void> => {
      try {
        await retryMessage(messageId)
      } catch (error) {
        window.alert(error instanceof Error ? error.message : 'Failed to retry this message.')
      }
    },
    [retryMessage]
  )

  const handleDelete = useCallback(
    async (messageId: string): Promise<void> => {
      const currentMessages = useAppStore.getState().messages[threadId!] ?? []
      const target = currentMessages.find((message) => message.id === messageId)
      if (!target || !confirmDelete(target)) {
        return
      }

      try {
        await deleteMessage(messageId)
      } catch (error) {
        window.alert(error instanceof Error ? error.message : 'Failed to delete this message.')
      }
    },
    [deleteMessage, threadId]
  )

  const handleSelectReplyBranch = useCallback(
    async (messageId: string): Promise<void> => {
      try {
        await selectReplyBranch(messageId)
      } catch (error) {
        window.alert(error instanceof Error ? error.message : 'Failed to switch reply branches.')
      }
    },
    [selectReplyBranch]
  )

  const isAcpThread = thread?.runtimeBinding?.kind === 'acp'
  const workspacePath = thread?.workspacePath

  const timelineItemContext = useMemo<TimelineItemRenderContext>(
    () => ({
      threadCapabilities,
      threadHasActiveRun,
      threadIsSaving,
      activeRequestMessageId,
      activeSubagents,
      subagentProgressEntries,
      retryInfo,
      runs,
      toolCalls,
      threadId,
      workspacePath,
      cancelRunForThread,
      revertPendingSteer,
      onEdit: handleEdit,
      onCreateBranch: handleCreateBranch,
      onRetry: handleRetry,
      onDelete: handleDelete,
      onSelectReplyBranch: handleSelectReplyBranch
    }),
    [
      threadCapabilities,
      threadHasActiveRun,
      threadIsSaving,
      activeRequestMessageId,
      activeSubagents,
      subagentProgressEntries,
      retryInfo,
      runs,
      toolCalls,
      threadId,
      workspacePath,
      cancelRunForThread,
      revertPendingSteer,
      handleEdit,
      handleCreateBranch,
      handleRetry,
      handleDelete,
      handleSelectReplyBranch
    ]
  )

  if (!threadId) {
    const activeEssential = activeEssentialId
      ? essentials?.find((e) => e.id === activeEssentialId)
      : null
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        {activeEssential ? (
          <>
            {activeEssential.iconType === 'image' ? (
              <img
                src={activeEssential.icon}
                alt={activeEssential.label ?? ''}
                style={{ width: 120, height: 120, borderRadius: '50%', objectFit: 'cover' }}
              />
            ) : (
              <span style={{ fontSize: 96, lineHeight: 1 }}>{activeEssential.icon}</span>
            )}
            <p className="text-xs" style={{ color: theme.text.muted }}>
              Creation with
            </p>
            {activeEssential.label && (
              <p
                className="text-base font-bold tracking-widest uppercase"
                style={{ color: theme.text.primary }}
              >
                {activeEssential.label}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm" style={{ color: theme.text.muted }}>
            Start a new thread or type below to create one automatically.
          </p>
        )}
      </div>
    )
  }

  if (timelineRows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm" style={{ color: theme.text.placeholder }}>
          No messages yet
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 relative min-h-0 min-w-0">
      {!isAcpThread && (
        <TimelineScrollbar
          messages={visibleMessages}
          scrollContainerRef={scrollContainerRef}
          onScrollToMessage={handleScrollToMessage}
        />
      )}
      <div
        ref={scrollContainerRef}
        data-timeline-scroll
        className="h-full overflow-y-auto overflow-x-hidden yachiyo-thread-enter"
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
              <strong className="not-italic">Recap:</strong> {recapText}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
