import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useShallow } from 'zustand/react/shallow'
import { Waypoints } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { HarnessRecord } from '@renderer/app/store/useAppStore'
import type { Message, RunRecord, Thread, ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { getThreadCapabilities } from '../../../../../shared/yachiyo/protocol.ts'
import { TimelineScrollbar } from './TimelineScrollbar'
import {
  buildMessageGroups,
  getRootAssistantMessages,
  getVisibleToolCallsForGroup,
  partitionToolCallsForGroups
} from '../lib/messageThreadPresentation'
import { findLatestRunForRequest, findRunMemorySummary } from '../lib/runMemoryPresentation.ts'
import { buildConversationGroupTimelineItems } from '../lib/messageTimelineLayout.ts'
import { buildMessageTimelineRows, type MessageTimelineRow } from '../lib/messageTimelineRows.ts'
import { UserMessageBubble } from './UserMessageBubble'
import { AssistantMessageBubble } from './AssistantMessageBubble'
import { GeneratingRow, type RetryInfo } from './GeneratingRow'
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

export const ThreadConversationGroup = memo(function ThreadConversationGroup({
  threadId,
  group,
  toolCalls,
  activeRunId,
  threadHasActiveRun,
  threadIsSaving,
  runs,
  subagentActive,
  activeSubagents,
  subagentProgressEntries,
  retryInfo,
  onCancelSubagent,
  threadCapabilities,
  onCreateBranch,
  onEdit,
  onRetry,
  onSelectReplyBranch,
  onDelete
}: {
  threadId: string
  group: ReturnType<typeof buildMessageGroups>[number]
  toolCalls: ToolCall[]
  activeRunId: string | null
  threadHasActiveRun: boolean
  threadIsSaving: boolean
  runs: RunRecord[]
  subagentActive: boolean
  activeSubagents: Array<{ delegationId: string; agentName: string; progress: string }>
  subagentProgressEntries: Array<{ delegationId: string; agentName: string; chunk: string }>
  retryInfo?: RetryInfo
  onCancelSubagent?: () => void
  threadCapabilities: NonNullable<Thread['capabilities']>
  onCreateBranch: (messageId: string) => Promise<void>
  onEdit: (messageId: string) => void
  onRetry: (messageId: string) => Promise<void>
  onSelectReplyBranch: (messageId: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
}): React.JSX.Element {
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
  const visibleToolCalls = useMemo(
    () => getVisibleToolCallsForGroup({ group, toolCalls, activeRunId }),
    [group, toolCalls, activeRunId]
  )
  const memorySummary = findRunMemorySummary(runs, group.userMessage.id)
  const savedMemoryCount = visibleToolCalls.filter(
    (tc) => tc.toolName === 'remember' && tc.status === 'completed'
  ).length
  const failedRunError =
    activeBranch?.message.status === 'failed'
      ? (findLatestRunForRequest(runs, group.userMessage.id, (run) => run.status === 'failed')
          ?.error ?? null)
      : null
  const activeAssistantTextBlocks = useMemo(() => {
    if (!activeBranch || group.hideActiveBranchWhilePreparing) return []
    if (activeBranch.message.textBlocks && activeBranch.message.textBlocks.length > 0) {
      return activeBranch.message.textBlocks
    }
    if (activeBranch.message.content.trim().length > 0) {
      return [
        {
          id: activeBranch.message.id,
          content: activeBranch.message.content,
          createdAt: activeBranch.message.createdAt
        }
      ]
    }
    return []
  }, [activeBranch, group.hideActiveBranchWhilePreparing])
  const hasRunningToolCall = visibleToolCalls.some(
    (toolCall) => toolCall.status === 'preparing' || toolCall.status === 'running'
  )
  const timelineItems = useMemo(
    () =>
      buildConversationGroupTimelineItems({
        hasMemoryRecall: Boolean(memorySummary),
        replyCount: responseCount,
        showPreparing: group.showPreparing && !subagentActive,
        showGenerating:
          activeBranch?.message.status === 'streaming' &&
          activeAssistantTextBlocks.length > 0 &&
          !hasRunningToolCall &&
          !subagentActive,
        activeAssistantTextBlocks,
        visibleToolCalls
      }),
    [
      memorySummary,
      responseCount,
      group.showPreparing,
      subagentActive,
      activeBranch,
      activeAssistantTextBlocks,
      hasRunningToolCall,
      visibleToolCalls
    ]
  )
  const textBlocksById = useMemo(
    () => new Map(activeAssistantTextBlocks.map((textBlock) => [textBlock.id, textBlock])),
    [activeAssistantTextBlocks]
  )
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
  const canSelectPreviousReply = canSwitchReplyBranches && Boolean(previousBranch)
  const canSelectNextReply = canSwitchReplyBranches && Boolean(nextBranch)

  const handleEditUser = useCallback(
    () => onEdit(group.userMessage.id),
    [onEdit, group.userMessage.id]
  )
  const handleRetryUser = useCallback(
    () => onRetry(retryTargetMessageId),
    [onRetry, retryTargetMessageId]
  )
  const handleCreateBranchUser = useCallback(
    () => onCreateBranch(group.userMessage.id),
    [onCreateBranch, group.userMessage.id]
  )
  const handleDeleteUser = useCallback(
    () => onDelete(group.userMessage.id),
    [onDelete, group.userMessage.id]
  )
  const handleSelectPreviousReply = useCallback(
    () => onSelectReplyBranch(previousBranch!.message.id),
    [onSelectReplyBranch, previousBranch]
  )
  const handleSelectNextReply = useCallback(
    () => onSelectReplyBranch(nextBranch!.message.id),
    [onSelectReplyBranch, nextBranch]
  )
  const handleRetryAssistant = useCallback(
    () => onRetry(activeBranch!.message.id),
    [onRetry, activeBranch]
  )
  const handleCreateBranchAssistant = useCallback(
    () => onCreateBranch(activeBranch!.message.id),
    [onCreateBranch, activeBranch]
  )
  const handleDeleteAssistant = useCallback(
    () => onDelete(activeBranch!.message.id),
    [onDelete, activeBranch]
  )

  return (
    <div className="flex flex-col gap-2" data-thread-id={threadId}>
      {group.userMessage.hidden ? null : (
        <UserMessageBubble
          message={group.userMessage}
          threadHasActiveRun={threadHasActiveRun}
          threadCapabilities={threadCapabilities}
          threadIsSaving={threadIsSaving}
          onEdit={canEditMessages ? handleEditUser : undefined}
          onRetry={threadCapabilities.canRetry ? handleRetryUser : undefined}
          onCreateBranch={canBranchMessages ? handleCreateBranchUser : undefined}
          onDelete={canDeleteMessages ? handleDeleteUser : undefined}
        />
      )}

      {responseCount > 1 ? (
        <div className="px-6 py-0.5">
          <ReplyBranchNavigation
            replyCount={responseCount}
            canSelectPreviousReply={canSelectPreviousReply}
            canSelectNextReply={canSelectNextReply}
            onSelectPreviousReply={canSelectPreviousReply ? handleSelectPreviousReply : undefined}
            onSelectNextReply={canSelectNextReply ? handleSelectNextReply : undefined}
          />
        </div>
      ) : null}

      {activeBranch?.message.reasoning ? (
        <ThinkingBlock
          reasoning={activeBranch.message.reasoning}
          isActive={activeBranch.message.status === 'streaming'}
        />
      ) : null}

      {timelineItems.map((item, index) => {
        const nextItem = timelineItems[index + 1]

        if (item.kind === 'memory-recall' && memorySummary) {
          return (
            <RunMemoryRecallRow
              key={item.key}
              entries={memorySummary.entries}
              recallDecision={memorySummary.recallDecision}
            />
          )
        }

        if (item.kind === 'tool-call') {
          const toolCall = visibleToolCalls.find((entry) => entry.id === item.toolCallId)
          return toolCall ? <ToolCallRow key={toolCall.id} toolCall={toolCall} /> : null
        }

        if (item.kind === 'tool-call-group') {
          const groupToolCalls = item.toolCallIds
            .map((id) => visibleToolCalls.find((entry) => entry.id === id))
            .filter((tc): tc is ToolCall => tc != null)
          return groupToolCalls.length > 0 ? (
            <ToolCallGroupRow key={item.key} group={item.group} toolCalls={groupToolCalls} />
          ) : null
        }

        if (item.kind === 'assistant-text-block' && activeBranch) {
          const textBlock = textBlocksById.get(item.textBlockId)
          if (!textBlock || !textBlock.content.trim()) {
            return null
          }

          const isLastTextBlock = activeAssistantTextBlocks.at(-1)?.id === item.textBlockId
          const nextToolCall =
            nextItem?.kind === 'tool-call'
              ? visibleToolCalls.find((entry) => entry.id === nextItem.toolCallId)
              : null
          const nextGroupHasRunning =
            nextItem?.kind === 'tool-call-group' &&
            nextItem.toolCallIds.some((id) => {
              const s = visibleToolCalls.find((entry) => entry.id === id)?.status
              return s === 'preparing' || s === 'running'
            })
          const compactBottomSpacing =
            nextToolCall?.status === 'preparing' ||
            nextToolCall?.status === 'running' ||
            nextGroupHasRunning
          return (
            <div
              key={item.key}
              className="message-response-cluster"
              data-message-id={activeBranch.message.id}
            >
              <AssistantMessageBubble
                message={activeBranch.message}
                contentOverride={textBlock.content}
                showFooter={false}
                suppressGeneratingLabel={
                  hasRunningToolCall || activeBranch.message.status === 'streaming'
                }
                pauseStreaming={subagentActive}
                showCaret={isLastTextBlock ? undefined : false}
                compactBottomSpacing={compactBottomSpacing}
              />
            </div>
          )
        }

        if (item.kind === 'generating') {
          return <GeneratingRow key="generating" retryInfo={retryInfo} />
        }

        if (item.kind === 'preparing') {
          if (retryInfo) {
            return <GeneratingRow key="preparing" retryInfo={retryInfo} />
          }
          return (
            <div key="preparing" className="message-response-cluster">
              <div className="message-response-cluster__preparing">
                <PreparingBubble />
              </div>
            </div>
          )
        }

        return null
      })}

      {activeBranch &&
      activeAssistantTextBlocks.length > 0 &&
      activeBranch.message.status !== 'streaming' &&
      !subagentActive ? (
        <div className="message-bubble-group px-6 py-1 flex flex-col gap-0.5">
          {activeBranch.message.status === 'stopped' ? (
            <div className="message-footer message-footer--always-visible">Stopped</div>
          ) : activeBranch.message.status === 'failed' ? (
            <div
              className="message-footer message-footer--always-visible"
              style={{ color: theme.text.danger }}
            >
              {failedRunError ? `Failed: ${failedRunError}` : 'Failed to generate'}
            </div>
          ) : null}
          {savedMemoryCount > 0 ? (
            <div
              className="message-footer message-footer--always-visible inline-flex items-center gap-1"
              style={{ color: theme.text.accent }}
            >
              {savedMemoryCount === 1 ? 'Memory saved' : `${savedMemoryCount} memories saved`}
            </div>
          ) : null}
          <RunStatsFooter
            runs={runs}
            toolCalls={toolCalls}
            requestMessageId={group.userMessage.id}
          />
          <MessageActionBar
            align="start"
            content={activeBranch.message.content}
            canRetry={canRetryAssistantMessage({
              messageStatus: activeBranch.message.status,
              threadCapabilities,
              threadHasActiveRun,
              threadIsSaving
            })}
            onRetry={threadCapabilities.canRetry ? handleRetryAssistant : undefined}
            onCreateBranch={canBranchMessages ? handleCreateBranchAssistant : undefined}
            onDelete={canDeleteMessages ? handleDeleteAssistant : undefined}
          />
        </div>
      ) : null}

      {subagentActive ? (
        <SubagentRunningIndicator
          agents={activeSubagents}
          progressEntries={subagentProgressEntries}
          onCancel={onCancelSubagent}
        />
      ) : null}
    </div>
  )
})

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
    revertQueuedFollowUp,
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
      revertQueuedFollowUp: state.revertQueuedFollowUp,
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

  const messageGroups = useMemo(
    () =>
      thread
        ? buildMessageGroups({
            thread,
            messages,
            runPhase,
            activeRequestMessageId
          })
        : [],
    [thread, messages, runPhase, activeRequestMessageId]
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
  const queuedFollowUpMessage = useMemo(
    () =>
      thread?.queuedFollowUpMessageId &&
      messages.some((message) => message.id === thread.queuedFollowUpMessageId)
        ? (messages.find((message) => message.id === thread.queuedFollowUpMessageId) ?? null)
        : null,
    [thread?.queuedFollowUpMessageId, messages]
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
  const threadActionContext = threadCapabilities
    ? { threadCapabilities, threadHasActiveRun, threadIsSaving }
    : null
  const canBranchHere = threadActionContext ? canCreateBranch(threadActionContext) : false
  const canDeleteHere = threadActionContext ? canDeleteMessage(threadActionContext) : false
  const timelineRows = useMemo(
    () =>
      buildMessageTimelineRows({
        messageGroups,
        rootAssistantMessages,
        harnessEvents,
        orphanToolCalls,
        pendingSteerMessage,
        queuedFollowUpMessage,
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
      queuedFollowUpMessage,
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
        ...(pendingSteerMessage ? [pendingSteerMessage] : []),
        ...(queuedFollowUpMessage ? [queuedFollowUpMessage] : [])
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [messageGroups, rootAssistantMessages, pendingSteerMessage, queuedFollowUpMessage]
  )

  const stickToBottomRef = useRef(true)
  const prevThreadIdRef = useRef(threadId)
  const programmaticScrollUntilRef = useRef(0)

  // Reset stick-to-bottom on thread switch, with suppression for measurement corrections
  if (prevThreadIdRef.current !== threadId) {
    stickToBottomRef.current = true
    programmaticScrollUntilRef.current = Date.now() + 500
    prevThreadIdRef.current = threadId
  }

  const timelineRef = useRef(timelineRows)
  timelineRef.current = timelineRows

  // Size cache keyed by timeline-item key. Survives unmount/remount so a row
  // scrolled offscreen and back doesn't snap back to a coarse estimate and
  // push later rows onto the same translateY — the original overlap bug.
  const measuredSizeCache = useRef<Map<string, number>>(new Map())

  const getScrollElement = useCallback(() => scrollContainerRef.current, [])
  // Conservative estimate: over-approximate on uncertainty. Overestimating
  // creates a transient scroll gap that self-corrects on measure; underestimating
  // causes rows to overlap until measure, and scrollToIndex lands too high.
  const estimateSize = useCallback((index: number) => {
    const item = timelineRef.current[index]
    if (!item) return 200
    const cached = measuredSizeCache.current.get(item.key)
    if (cached != null && cached > 0) return cached
    switch (item.kind) {
      case 'harness':
        return 56
      case 'tool':
        return 72
      case 'pending-steer':
      case 'queued-follow-up':
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
  }, [])
  const getItemKey = useCallback((index: number) => timelineRef.current[index].key, [])

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
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
      if (v.size > 0) {
        measuredSizeCache.current.set(String(v.key), v.size)
      }
    }
  })

  const findTimelineIndex = useCallback(
    (messageId: string): number =>
      timelineRef.current.findIndex(
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
      programmaticScrollUntilRef.current = Date.now() + 300
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
    [findTimelineIndex, virtualizer]
  )

  // Track user scroll to detect manual scroll-away
  useEffect(() => {
    if (recapText && recapRef.current && stickToBottomRef.current) {
      recapRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [recapText])

  // Deps include threadId and timeline.length so the listener reattaches
  // when the scroll container first appears (empty thread → first message)
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const handleScroll = (): void => {
      // Ignore scroll events caused by programmatic scroll + measurement corrections
      if (Date.now() < programmaticScrollUntilRef.current) return
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight
      // Hysteresis: avoid rapid flipping from virtualizer measurement lag.
      if (!stickToBottomRef.current && distanceFromBottom < 50) {
        stickToBottomRef.current = true
      } else if (stickToBottomRef.current && distanceFromBottom > 200) {
        stickToBottomRef.current = false
      }
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [threadId, timelineRows.length])

  const scrollToBottom = useCallback((): void => {
    if (timelineRef.current.length === 0) return
    programmaticScrollUntilRef.current = Date.now() + 300
    virtualizer.scrollToIndex(timelineRef.current.length - 1, { align: 'end' })
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
        if (timelineRef.current.length === 0) return
        programmaticScrollUntilRef.current = Date.now() + 300
        virtualizer.scrollToIndex(timelineRef.current.length - 1, { align: 'end' })
      })
    })
  }, [virtualizer])

  // Scroll to bottom on thread switch — suppression already set above
  useEffect(() => {
    if (timelineRows.length === 0) return
    virtualizer.scrollToIndex(timelineRows.length - 1, { align: 'end' })
  }, [threadId]) // eslint-disable-line react-hooks/exhaustive-deps

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
  const streamingScrollRafRef = useRef<number | null>(null)
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
      if (streamingScrollRafRef.current !== null) {
        cancelAnimationFrame(streamingScrollRafRef.current)
      }
    }
  }, [])

  // Scroll-to-message: bring the group into view via virtualizer, then refine to exact element
  useEffect(() => {
    if (!scrollToMessageId || timelineRows.length === 0) return
    const targetMessageId = scrollToMessageId
    clearScrollToMessageId()

    const targetIndex = findTimelineIndex(targetMessageId)
    if (targetIndex < 0) return

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
  }, [scrollToMessageId, timelineRows, clearScrollToMessageId, findTimelineIndex]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const renderTimelineItem = useCallback(
    (item: MessageTimelineRow): React.JSX.Element | null => {
      if (item.kind === 'harness') {
        return <RunEventRow harness={item.data} />
      }

      if (item.kind === 'queued-follow-up') {
        if (!threadCapabilities || item.data.hidden) return null
        return (
          <div data-message-id={item.key}>
            <UserMessageBubble
              label="Queued follow-up"
              message={item.data}
              threadHasActiveRun={threadHasActiveRun}
              threadCapabilities={threadCapabilities}
              threadIsSaving={threadIsSaving}
              onRetry={threadCapabilities.canRetry ? () => handleRetry(item.data.id) : undefined}
              onCreateBranch={canBranchHere ? () => handleCreateBranch(item.data.id) : undefined}
              onDelete={canDeleteHere ? () => handleDelete(item.data.id) : undefined}
              onRevert={() => revertQueuedFollowUp(item.data.id)}
            />
          </div>
        )
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
        return <ToolCallRow toolCall={item.data} />
      }

      if (item.kind === 'assistant-root') {
        if (item.data.status === 'streaming' && !item.data.content.trim()) {
          return (
            <div data-message-id={item.key}>
              {item.data.reasoning ? (
                <ThinkingBlock reasoning={item.data.reasoning} isActive={true} />
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
        isActiveGroup && activeSubagents.length === 1
          ? () => void cancelRunForThread(threadId!)
          : undefined

      if (item.kind === 'group-user') {
        return (
          <div data-message-id={group.userMessage.id}>
            <UserMessageBubble
              message={group.userMessage}
              threadHasActiveRun={threadHasActiveRun}
              threadCapabilities={threadCapabilities}
              threadIsSaving={threadIsSaving}
              onEdit={canEditMessages ? () => handleEdit(group.userMessage.id) : undefined}
              onRetry={
                threadCapabilities.canRetry ? () => handleRetry(retryTargetMessageId) : undefined
              }
              onCreateBranch={
                canBranchMessages ? () => handleCreateBranch(group.userMessage.id) : undefined
              }
              onDelete={canDeleteMessages ? () => handleDelete(group.userMessage.id) : undefined}
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
                  ? () => void handleSelectReplyBranch(previousBranch.message.id)
                  : undefined
              }
              onSelectNextReply={
                canSwitchReplyBranches && nextBranch
                  ? () => void handleSelectReplyBranch(nextBranch.message.id)
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
            />
          </div>
        )
      }

      if (item.kind === 'group-memory-recall') {
        return <RunMemoryRecallRow entries={item.entries} recallDecision={item.recallDecision} />
      }

      if (item.kind === 'group-tool-call') {
        return <ToolCallRow toolCall={item.toolCall} />
      }

      if (item.kind === 'group-tool-call-group') {
        return <ToolCallGroupRow group={item.toolGroup} toolCalls={item.toolCalls} />
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
              pauseStreaming={isActiveGroup && subagentActive}
              showCaret={item.isLastTextBlock ? undefined : false}
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
                threadCapabilities.canRetry
                  ? () => handleRetry(item.assistantMessage.id)
                  : undefined
              }
              onCreateBranch={
                canBranchMessages ? () => handleCreateBranch(item.assistantMessage.id) : undefined
              }
              onDelete={
                canDeleteMessages ? () => handleDelete(item.assistantMessage.id) : undefined
              }
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
    },
    [
      threadCapabilities,
      threadHasActiveRun,
      threadIsSaving,
      activeRequestMessageId,
      subagentActive,
      activeSubagents,
      subagentProgressEntries,
      retryInfo,
      runs,
      toolCalls,
      canBranchHere,
      canDeleteHere,
      threadId,
      handleEdit,
      handleCreateBranch,
      handleRetry,
      handleDelete,
      handleSelectReplyBranch,
      cancelRunForThread,
      revertPendingSteer,
      revertQueuedFollowUp
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

            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  contain: 'content',
                  animation: 'yachiyo-row-enter 150ms ease-out'
                }}
              >
                {renderTimelineItem(item)}
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
