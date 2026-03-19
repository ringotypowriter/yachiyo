import type React from 'react'
import { useEffect, useRef } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { HarnessRecord } from '@renderer/app/store/useAppStore'
import type { Message, ToolCall } from '@renderer/app/types'
import {
  buildMessageGroups,
  getVisibleToolCallsForGroup,
  partitionToolCallsForGroups
} from '../lib/messageThreadPresentation'
import { UserMessageBubble } from './UserMessageBubble'
import { AssistantMessageBubble } from './AssistantMessageBubble'
import { PreparingBubble } from './PreparingBubble'
import { RunEventRow } from './RunEventRow'
import { ToolCallRow } from './ToolCallRow'

interface MessageTimelineProps {
  threadId: string | null
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_HARNESSES: HarnessRecord[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []

const DEFAULT_HARNESS = 'default.reply'

type TimelineItem =
  | ReturnType<typeof buildConversationTimeline>[number]
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
  harnesses: HarnessRecord[],
  orphanToolCalls: ToolCall[],
  queuedFollowUpMessage: Message | null
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...buildConversationTimeline(groups),
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

function ThreadConversationGroup({
  threadId,
  group,
  toolCalls,
  threadHasActiveRun,
  onCreateBranch,
  onRetry,
  onSelectReplyBranch,
  onDelete
}: {
  threadId: string
  group: ReturnType<typeof buildMessageGroups>[number]
  toolCalls: ToolCall[]
  threadHasActiveRun: boolean
  onCreateBranch: (messageId: string) => Promise<void>
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
  const retryTargetMessageId = activeBranch?.message.id ?? group.userMessage.id
  const visibleToolCalls = getVisibleToolCallsForGroup({ group, toolCalls })

  return (
    <div className="flex flex-col gap-2" data-thread-id={threadId}>
      <UserMessageBubble
        message={group.userMessage}
        threadHasActiveRun={threadHasActiveRun}
        onRetry={() => onRetry(retryTargetMessageId)}
        onCreateBranch={() => onCreateBranch(group.userMessage.id)}
        onDelete={() => onDelete(group.userMessage.id)}
      />

      {visibleToolCalls.map((toolCall) => (
        <ToolCallRow key={toolCall.id} toolCall={toolCall} />
      ))}

      {responseCount > 0 || group.showPreparing ? (
        <div className="message-response-cluster">
          {activeBranch ? (
            <AssistantMessageBubble
              key={activeBranch.message.id}
              message={activeBranch.message}
              replyCount={responseCount}
              canSelectPreviousReply={!threadHasActiveRun && Boolean(previousBranch)}
              canSelectNextReply={!threadHasActiveRun && Boolean(nextBranch)}
              threadHasActiveRun={threadHasActiveRun}
              onRetry={() => onRetry(activeBranch.message.id)}
              onSelectPreviousReply={
                previousBranch ? () => onSelectReplyBranch(previousBranch.message.id) : undefined
              }
              onSelectNextReply={
                nextBranch ? () => onSelectReplyBranch(nextBranch.message.id) : undefined
              }
              onCreateBranch={() => onCreateBranch(activeBranch.message.id)}
              onDelete={() => onDelete(activeBranch.message.id)}
            />
          ) : null}

          {group.showPreparing ? (
            <div className="message-response-cluster__preparing">
              <PreparingBubble />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function MessageTimeline({ threadId }: MessageTimelineProps): React.JSX.Element {
  const thread = useAppStore((state) =>
    threadId ? (state.threads.find((entry) => entry.id === threadId) ?? null) : null
  )
  const messages = useAppStore((state) =>
    threadId ? (state.messages[threadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const harnessEvents = useAppStore((state) =>
    threadId ? (state.harnessEvents[threadId] ?? EMPTY_HARNESSES) : EMPTY_HARNESSES
  )
  const toolCalls = useAppStore((state) =>
    threadId ? (state.toolCalls[threadId] ?? EMPTY_TOOL_CALLS) : EMPTY_TOOL_CALLS
  )
  const activeRunThreadId = useAppStore((state) => state.activeRunThreadId)
  const activeRequestMessageId = useAppStore((state) => state.activeRequestMessageId)
  const createBranch = useAppStore((state) => state.createBranch)
  const deleteMessage = useAppStore((state) => state.deleteMessage)
  const retryMessage = useAppStore((state) => state.retryMessage)
  const selectReplyBranch = useAppStore((state) => state.selectReplyBranch)
  const runPhase = useAppStore((state) => state.runPhase)
  const bottomRef = useRef<HTMLDivElement>(null)

  const messageGroups = thread
    ? buildMessageGroups({
        thread,
        messages,
        runPhase,
        activeRequestMessageId: activeRunThreadId === threadId ? activeRequestMessageId : null
      })
    : []
  const queuedFollowUpMessage =
    thread?.queuedFollowUpMessageId &&
    messages.some((message) => message.id === thread.queuedFollowUpMessageId)
      ? (messages.find((message) => message.id === thread.queuedFollowUpMessageId) ?? null)
      : null
  const { inlineToolCalls, orphanToolCalls } = partitionToolCallsForGroups({
    groups: messageGroups,
    toolCalls
  })
  const timeline = buildTimeline(
    messageGroups,
    harnessEvents,
    orphanToolCalls,
    queuedFollowUpMessage
  )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeRequestMessageId, harnessEvents, messages, runPhase, toolCalls])

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
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm" style={{ color: '#8a8680' }}>
          Start a new thread or type below to create one automatically.
        </p>
      </div>
    )
  }

  if (timeline.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm" style={{ color: '#aaa' }}>
          No messages yet
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto py-4">
      {timeline.map((item) => {
        if (item.kind === 'harness') {
          return <RunEventRow key={item.key} harness={item.data} />
        }

        if (item.kind === 'queued-follow-up') {
          return (
            <UserMessageBubble
              key={item.key}
              label="Queued follow-up"
              message={item.data}
              threadHasActiveRun={activeRunThreadId === threadId}
              onRetry={() => handleRetry(item.data.id)}
              onCreateBranch={() => handleCreateBranch(item.data.id)}
              onDelete={() => handleDelete(item.data.id)}
            />
          )
        }

        if (item.kind === 'tool') {
          return <ToolCallRow key={item.key} toolCall={item.data} />
        }

        return (
          <ThreadConversationGroup
            key={item.key}
            threadId={threadId}
            group={item.data}
            toolCalls={inlineToolCalls}
            threadHasActiveRun={activeRunThreadId === threadId}
            onCreateBranch={handleCreateBranch}
            onRetry={handleRetry}
            onSelectReplyBranch={handleSelectReplyBranch}
            onDelete={handleDelete}
          />
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
