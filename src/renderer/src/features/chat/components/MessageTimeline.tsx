import React, { useEffect, useRef } from 'react'
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
import { findRunMemorySummary } from '../lib/runMemoryPresentation.ts'
import { buildConversationGroupTimelineItems } from '../lib/messageTimelineLayout.ts'
import { UserMessageBubble } from './UserMessageBubble'
import { AssistantMessageBubble } from './AssistantMessageBubble'
import { GeneratingRow, type RetryInfo } from './GeneratingRow'
import { SubagentRunningIndicator } from './SubagentRunningIndicator'
import { PreparingBubble } from './PreparingBubble'
import { RunEventRow } from './RunEventRow'
import { RunMemoryRecallRow } from './RunMemoryRecallRow'
import { ReplyBranchNavigation } from './ReplyBranchNavigation'
import { ToolCallRow } from './ToolCallRow'
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

interface MessageTimelineProps {
  threadId: string | null
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_HARNESSES: HarnessRecord[] = []
const EMPTY_RUNS: RunRecord[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []

const DEFAULT_HARNESS = 'default.reply'

type TimelineItem =
  | ReturnType<typeof buildConversationTimeline>[number]
  | { kind: 'assistant-root'; key: string; time: string; data: Message }
  | { kind: 'pending-steer'; key: string; time: string; data: Message }
  | { kind: 'queued-follow-up'; key: string; time: string; data: Message }
  | { kind: 'harness'; key: string; time: string; data: HarnessRecord }
  | { kind: 'tool'; key: string; time: string; data: ToolCall }

function buildConversationTimeline(
  groups: ReturnType<typeof buildMessageGroups>
): Array<{ kind: 'group'; key: string; time: string; data: (typeof groups)[number] }> {
  return groups.map((group) => ({
    kind: 'group' as const,
    key: group.userMessage.id,
    time: group.userMessage.createdAt,
    data: group
  }))
}

function buildTimeline(
  groups: ReturnType<typeof buildMessageGroups>,
  rootAssistantMessages: Message[],
  harnesses: HarnessRecord[],
  orphanToolCalls: ToolCall[],
  pendingSteerMessage: Message | null,
  queuedFollowUpMessage: Message | null
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...buildConversationTimeline(groups),
    ...rootAssistantMessages.map((message) => ({
      kind: 'assistant-root' as const,
      key: message.id,
      time: message.createdAt,
      data: message
    })),
    ...(pendingSteerMessage
      ? [
          {
            kind: 'pending-steer' as const,
            key: pendingSteerMessage.id,
            time: pendingSteerMessage.createdAt,
            data: pendingSteerMessage
          }
        ]
      : []),
    ...(queuedFollowUpMessage
      ? [
          {
            kind: 'queued-follow-up' as const,
            key: queuedFollowUpMessage.id,
            time: queuedFollowUpMessage.createdAt,
            data: queuedFollowUpMessage
          }
        ]
      : []),
    ...orphanToolCalls.map((toolCall) => ({
      kind: 'tool' as const,
      key: toolCall.id,
      time: toolCall.startedAt,
      data: toolCall
    })),
    ...harnesses
      .filter((harness) => harness.name !== DEFAULT_HARNESS)
      .map((harness) => ({
        kind: 'harness' as const,
        key: harness.id,
        time: harness.startedAt,
        data: harness
      }))
  ]

  return items.sort((left, right) => left.time.localeCompare(right.time))
}

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

export function ThreadConversationGroup({
  threadId,
  group,
  toolCalls,
  activeRunId,
  threadHasActiveRun,
  threadIsSaving,
  runs,
  subagentActive,
  subagentStream,
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
  subagentStream: string
  retryInfo?: RetryInfo
  onCancelSubagent: () => void
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
  const visibleToolCalls = getVisibleToolCallsForGroup({ group, toolCalls, activeRunId })
  const memorySummary = findRunMemorySummary(runs, group.userMessage.id)
  const activeAssistantTextBlocks =
    activeBranch && !group.hideActiveBranchWhilePreparing
      ? activeBranch.message.textBlocks && activeBranch.message.textBlocks.length > 0
        ? activeBranch.message.textBlocks
        : activeBranch.message.content.trim().length > 0
          ? [
              {
                id: activeBranch.message.id,
                content: activeBranch.message.content,
                createdAt: activeBranch.message.createdAt
              }
            ]
          : []
      : []
  const hasRunningToolCall = visibleToolCalls.some((toolCall) => toolCall.status === 'running')
  const timelineItems = buildConversationGroupTimelineItems({
    hasMemoryRecall: Boolean(memorySummary),
    replyCount: responseCount,
    showPreparing: group.showPreparing && !subagentActive,
    showGenerating:
      activeBranch?.message.status === 'streaming' &&
      activeAssistantTextBlocks.length > 0 &&
      !hasRunningToolCall &&
      !subagentActive,
    activeBranchStatus: activeBranch?.message.status,
    activeAssistantTextBlocks,
    visibleToolCalls
  })
  const textBlocksById = new Map(
    activeAssistantTextBlocks.map((textBlock) => [textBlock.id, textBlock])
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

  return (
    <div className="flex flex-col gap-2" data-thread-id={threadId}>
      <UserMessageBubble
        message={group.userMessage}
        threadHasActiveRun={threadHasActiveRun}
        threadCapabilities={threadCapabilities}
        threadIsSaving={threadIsSaving}
        onEdit={canEditMessages ? () => onEdit(group.userMessage.id) : undefined}
        onRetry={threadCapabilities.canRetry ? () => onRetry(retryTargetMessageId) : undefined}
        onCreateBranch={canBranchMessages ? () => onCreateBranch(group.userMessage.id) : undefined}
        onDelete={canDeleteMessages ? () => onDelete(group.userMessage.id) : undefined}
      />

      {responseCount > 1 ? (
        <div className="px-6 py-0.5">
          <ReplyBranchNavigation
            replyCount={responseCount}
            canSelectPreviousReply={canSelectPreviousReply}
            canSelectNextReply={canSelectNextReply}
            onSelectPreviousReply={
              canSelectPreviousReply
                ? () => onSelectReplyBranch(previousBranch!.message.id)
                : undefined
            }
            onSelectNextReply={
              canSelectNextReply ? () => onSelectReplyBranch(nextBranch!.message.id) : undefined
            }
          />
        </div>
      ) : null}

      {activeBranch?.message.reasoning ? (
        <ThinkingBlock
          reasoning={activeBranch.message.reasoning}
          isActive={activeBranch.message.status === 'streaming' && !activeBranch.message.content}
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

        if (item.kind === 'assistant-text-block' && activeBranch) {
          const textBlock = textBlocksById.get(item.textBlockId)
          if (!textBlock) {
            return null
          }

          const nextToolCall =
            nextItem?.kind === 'tool-call'
              ? visibleToolCalls.find((entry) => entry.id === nextItem.toolCallId)
              : null
          const compactBottomSpacing = nextToolCall?.status === 'running'
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
              Failed to generate
            </div>
          ) : null}
          <MessageActionBar
            align="start"
            content={activeBranch.message.content}
            canRetry={canRetryAssistantMessage({
              messageStatus: activeBranch.message.status,
              threadCapabilities,
              threadHasActiveRun,
              threadIsSaving
            })}
            onRetry={
              threadCapabilities.canRetry ? () => onRetry(activeBranch.message.id) : undefined
            }
            onCreateBranch={
              canBranchMessages ? () => onCreateBranch(activeBranch.message.id) : undefined
            }
            onDelete={canDeleteMessages ? () => onDelete(activeBranch.message.id) : undefined}
          />
        </div>
      ) : null}

      {subagentActive ? (
        <SubagentRunningIndicator
          threadId={threadId}
          stream={subagentStream}
          onCancel={onCancelSubagent}
        />
      ) : null}
    </div>
  )
}

export function MessageTimeline({ threadId }: MessageTimelineProps): React.JSX.Element {
  const thread = useAppStore((state) =>
    threadId
      ? (state.threads.find((entry) => entry.id === threadId) ??
        state.externalThreads.find((entry) => entry.id === threadId) ??
        null)
      : null
  )
  const messages = useAppStore((state) =>
    threadId ? (state.messages[threadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const harnessEvents = useAppStore((state) =>
    threadId ? (state.harnessEvents[threadId] ?? EMPTY_HARNESSES) : EMPTY_HARNESSES
  )
  const pendingSteerEntry = useAppStore((state) =>
    threadId ? (state.pendingSteerMessages[threadId] ?? null) : null
  )
  const toolCalls = useAppStore((state) =>
    threadId ? (state.toolCalls[threadId] ?? EMPTY_TOOL_CALLS) : EMPTY_TOOL_CALLS
  )
  const runs = useAppStore((state) =>
    threadId ? (state.runsByThread[threadId] ?? EMPTY_RUNS) : EMPTY_RUNS
  )
  const activeRunId = useAppStore((state) =>
    threadId ? (state.activeRunIdsByThread[threadId] ?? null) : null
  )
  const threadIsSaving = useAppStore((state) =>
    threadId ? state.savingThreadIds.has(threadId) : false
  )
  const subagentActive = useAppStore((state) =>
    threadId ? (state.subagentActiveByThread[threadId] ?? false) : false
  )
  const subagentStream = useAppStore((state) =>
    threadId ? (state.subagentProgressByThread[threadId] ?? '') : ''
  )
  const retryInfo = useAppStore((state) =>
    threadId ? (state.retryInfoByThread[threadId] ?? undefined) : undefined
  )
  const cancelRunForThread = useAppStore((state) => state.cancelRunForThread)
  const activeRequestMessageId = useAppStore((state) =>
    threadId ? (state.activeRequestMessageIdsByThread[threadId] ?? null) : null
  )
  const beginEditMessage = useAppStore((state) => state.beginEditMessage)
  const createBranch = useAppStore((state) => state.createBranch)
  const deleteMessage = useAppStore((state) => state.deleteMessage)
  const retryMessage = useAppStore((state) => state.retryMessage)
  const selectReplyBranch = useAppStore((state) => state.selectReplyBranch)
  const runPhase = useAppStore((state) =>
    threadId ? (state.runPhasesByThread[threadId] ?? 'idle') : 'idle'
  )
  const scrollToMessageId = useAppStore((state) => state.scrollToMessageId)
  const clearScrollToMessageId = useAppStore((state) => state.clearScrollToMessageId)
  const activeEssentialId = useAppStore((state) => state.activeEssentialId)
  const essentials = useAppStore((state) => state.config?.essentials)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const messageGroups = thread
    ? buildMessageGroups({
        thread,
        messages,
        runPhase,
        activeRequestMessageId
      })
    : []
  const pendingSteerMessage =
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
      : null
  const queuedFollowUpMessage =
    thread?.queuedFollowUpMessageId &&
    messages.some((message) => message.id === thread.queuedFollowUpMessageId)
      ? (messages.find((message) => message.id === thread.queuedFollowUpMessageId) ?? null)
      : null
  const { inlineToolCalls, orphanToolCalls } = partitionToolCallsForGroups({
    groups: messageGroups,
    toolCalls
  })
  const rootAssistantMessages = getRootAssistantMessages(messages)
  const threadCapabilities = thread ? getThreadCapabilities(thread) : null
  const threadHasActiveRun = activeRunId !== null
  const threadActionContext = threadCapabilities
    ? { threadCapabilities, threadHasActiveRun, threadIsSaving }
    : null
  const canBranchHere = threadActionContext ? canCreateBranch(threadActionContext) : false
  const canDeleteHere = threadActionContext ? canDeleteMessage(threadActionContext) : false
  const timeline = buildTimeline(
    messageGroups,
    rootAssistantMessages,
    harnessEvents,
    orphanToolCalls,
    pendingSteerMessage,
    queuedFollowUpMessage
  )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeRequestMessageId, harnessEvents, messages, runPhase, toolCalls])

  useEffect(() => {
    if (!scrollToMessageId || messages.length === 0) return
    const element = document.querySelector(`[data-message-id="${scrollToMessageId}"]`)
    clearScrollToMessageId()
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [scrollToMessageId, messages, clearScrollToMessageId])

  function handleEdit(messageId: string): void {
    beginEditMessage(messageId)
  }

  async function handleCreateBranch(messageId: string): Promise<void> {
    try {
      await createBranch(messageId)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to create a branch.')
    }
  }

  async function handleRetry(messageId: string): Promise<void> {
    try {
      await retryMessage(messageId)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to retry this message.')
    }
  }

  async function handleDelete(messageId: string): Promise<void> {
    const target = messages.find((message) => message.id === messageId)
    if (!target || !confirmDelete(target)) {
      return
    }

    try {
      await deleteMessage(messageId)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to delete this message.')
    }
  }

  async function handleSelectReplyBranch(messageId: string): Promise<void> {
    try {
      await selectReplyBranch(messageId)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to switch reply branches.')
    }
  }

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

  if (timeline.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm" style={{ color: theme.text.placeholder }}>
          No messages yet
        </p>
      </div>
    )
  }

  const isAcpThread = thread?.runtimeBinding?.kind === 'acp'

  // Collect only the messages visible on the active branch for the scrollbar.
  const visibleMessages: Message[] = [
    ...messageGroups.flatMap((group) => {
      const branch = group.assistantBranches[group.activeBranchIndex]
      return branch ? [group.userMessage, branch.message] : [group.userMessage]
    }),
    ...rootAssistantMessages,
    ...(pendingSteerMessage ? [pendingSteerMessage] : []),
    ...(queuedFollowUpMessage ? [queuedFollowUpMessage] : [])
  ]

  return (
    <div className="flex-1 relative min-h-0">
      {!isAcpThread && (
        <TimelineScrollbar messages={visibleMessages} scrollContainerRef={scrollContainerRef} />
      )}
      <div ref={scrollContainerRef} className="h-full overflow-y-auto overflow-x-hidden py-4">
        {timeline.map((item) => {
          if (item.kind === 'harness') {
            return <RunEventRow key={item.key} harness={item.data} />
          }

          if (item.kind === 'queued-follow-up') {
            if (!threadCapabilities) {
              return null
            }

            return (
              <div key={item.key} data-message-id={item.key}>
                <UserMessageBubble
                  label="Queued follow-up"
                  message={item.data}
                  threadHasActiveRun={threadHasActiveRun}
                  threadCapabilities={threadCapabilities}
                  threadIsSaving={threadIsSaving}
                  onRetry={
                    threadCapabilities.canRetry ? () => handleRetry(item.data.id) : undefined
                  }
                  onCreateBranch={
                    canBranchHere ? () => handleCreateBranch(item.data.id) : undefined
                  }
                  onDelete={canDeleteHere ? () => handleDelete(item.data.id) : undefined}
                />
              </div>
            )
          }

          if (item.kind === 'pending-steer') {
            if (!threadCapabilities) {
              return null
            }

            return (
              <div key={item.key} data-message-id={item.key}>
                <UserMessageBubble
                  label="Pending steer"
                  pending
                  message={item.data}
                  threadHasActiveRun
                  threadCapabilities={threadCapabilities}
                  onRetry={() => undefined}
                  onCreateBranch={() => undefined}
                  onDelete={() => undefined}
                />
              </div>
            )
          }

          if (item.kind === 'tool') {
            return <ToolCallRow key={item.key} toolCall={item.data} />
          }

          if (item.kind === 'assistant-root') {
            if (item.data.status === 'streaming' && !item.data.content.trim()) {
              return (
                <div key={item.key} className="message-response-cluster">
                  <div className="message-response-cluster__preparing">
                    <PreparingBubble />
                  </div>
                </div>
              )
            }

            return (
              <div key={item.key} data-message-id={item.key}>
                <AssistantMessageBubble message={item.data} />
              </div>
            )
          }

          const isActiveGroup = item.data.userMessage.id === activeRequestMessageId
          if (!threadCapabilities) {
            return null
          }

          return (
            <div key={item.key} data-message-id={item.key}>
              <ThreadConversationGroup
                threadId={threadId}
                group={item.data}
                toolCalls={inlineToolCalls}
                activeRunId={activeRunId}
                threadHasActiveRun={threadHasActiveRun}
                threadIsSaving={threadIsSaving}
                runs={runs}
                subagentActive={isActiveGroup && subagentActive}
                subagentStream={subagentStream}
                retryInfo={isActiveGroup ? retryInfo : undefined}
                onCancelSubagent={() => void cancelRunForThread(threadId)}
                threadCapabilities={threadCapabilities}
                onCreateBranch={handleCreateBranch}
                onEdit={handleEdit}
                onRetry={handleRetry}
                onSelectReplyBranch={handleSelectReplyBranch}
                onDelete={handleDelete}
              />
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
