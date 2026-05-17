import type { Message, MessageTextBlockRecord, RunRecord, ToolCall } from '@renderer/app/types'
import {
  buildConversationGroupTimelineItems,
  type ToolCallSemanticGroup
} from './messageTimelineLayout.ts'
import {
  getVisibleToolCallsForGroup,
  isActiveRequestForGroup,
  type MessageGroup
} from './messageThreadPresentation.ts'
import {
  findLatestRunForRequests,
  findRunMemorySummaryForRequests
} from './runMemoryPresentation.ts'

type GroupTimelineRowBase = {
  key: string
  time: string
  requestMessageId: string
  scrollMessageId?: string
  assistantMessageId?: string
}

export type MessageTimelineRow =
  | ({
      kind: 'group-user'
      group: MessageGroup
    } & GroupTimelineRowBase)
  | ({
      kind: 'group-branch-navigation'
      group: MessageGroup
      activeAssistantMessageId?: string
    } & GroupTimelineRowBase)
  | ({
      kind: 'group-thinking'
      group: MessageGroup
      assistantMessage: Message
    } & GroupTimelineRowBase)
  | ({
      kind: 'group-memory-recall'
      group: MessageGroup
      entries: string[]
      recallDecision?: RunRecord['recallDecision']
    } & GroupTimelineRowBase)
  | ({
      kind: 'group-tool-call'
      group: MessageGroup
      toolCall: ToolCall
    } & GroupTimelineRowBase)
  | ({
      kind: 'group-tool-call-group'
      group: MessageGroup
      toolGroup: ToolCallSemanticGroup
      toolCalls: ToolCall[]
    } & GroupTimelineRowBase)
  | ({
      kind: 'group-assistant-text-block'
      group: MessageGroup
      assistantMessage: Message
      textBlock: MessageTextBlockRecord
      hasRunningToolCall: boolean
      isLastTextBlock: boolean
      isStreaming: boolean
      compactBottomSpacing: boolean
    } & GroupTimelineRowBase)
  | ({
      kind: 'group-generating'
      group: MessageGroup
    } & GroupTimelineRowBase)
  | ({
      kind: 'group-preparing'
      group: MessageGroup
    } & GroupTimelineRowBase)
  | ({
      kind: 'group-footer'
      group: MessageGroup
      assistantMessage: Message
      savedMemoryCount: number
      failedRunError: string | null
    } & GroupTimelineRowBase)
  | ({
      kind: 'group-subagent'
      group: MessageGroup
    } & GroupTimelineRowBase)
  | {
      kind: 'assistant-root'
      key: string
      time: string
      data: Message
      scrollMessageId: string
    }
  | {
      kind: 'pending-steer'
      key: string
      time: string
      data: Message
      scrollMessageId: string
    }
  | {
      kind: 'tool'
      key: string
      time: string
      data: ToolCall
    }

interface BuildConversationGroupRowsInput {
  group: MessageGroup
  inlineToolCalls: ToolCall[]
  runs: RunRecord[]
  activeRunId: string | null
  isActiveGroup: boolean
  subagentActive: boolean
}

interface BuildMessageTimelineRowsInput {
  messageGroups: MessageGroup[]
  rootAssistantMessages: Message[]
  orphanToolCalls: ToolCall[]
  pendingSteerMessage: Message | null
  inlineToolCalls: ToolCall[]
  runs: RunRecord[]
  activeRunId: string | null
  activeRequestMessageId: string | null
  subagentActive: boolean
}

function compareBlocks(
  left: { time: string; rows: MessageTimelineRow[] },
  right: { time: string; rows: MessageTimelineRow[] }
): number {
  return left.time.localeCompare(right.time)
}

function resolveAssistantTextBlocks(message: Message): MessageTextBlockRecord[] {
  if (message.visibleReply !== undefined) {
    if (message.visibleReply.trim().length === 0) return []
    return [
      {
        id: `${message.id}:visible-reply`,
        content: message.visibleReply,
        createdAt: message.createdAt
      }
    ]
  }

  if (message.textBlocks && message.textBlocks.length > 0) {
    return message.textBlocks
  }

  if (message.content.trim().length > 0) {
    return [
      {
        id: message.id,
        content: message.content,
        createdAt: message.createdAt
      }
    ]
  }

  return []
}

function getActiveAssistantMessages(group: MessageGroup): Message[] {
  if (group.activeAssistantMessages.length > 0) {
    return group.activeAssistantMessages
  }

  const activeBranch =
    group.activeBranchIndex >= 0 ? group.assistantBranches[group.activeBranchIndex] : null
  return activeBranch ? [activeBranch.message] : []
}

export function collectInlineCodeMarkdownDocumentsFromRows(
  rows: readonly MessageTimelineRow[]
): string[] {
  const documents: string[] = []

  for (const row of rows) {
    if (row.kind === 'group-assistant-text-block') {
      if (row.assistantMessage.status !== 'streaming' && row.textBlock.content.length > 0) {
        documents.push(row.textBlock.content)
      }
      continue
    }

    if (row.kind === 'assistant-root') {
      if (row.data.status === 'streaming') {
        continue
      }
      const content = row.data.visibleReply ?? row.data.content
      if (content.length > 0) {
        documents.push(content)
      }
    }
  }

  return documents
}

export function buildConversationGroupRows(
  input: BuildConversationGroupRowsInput
): MessageTimelineRow[] {
  const { group } = input
  const rows: MessageTimelineRow[] = []
  const responseCount = group.assistantBranches.length
  const activeBranch =
    group.activeBranchIndex >= 0 ? group.assistantBranches[group.activeBranchIndex] : null
  const activeAssistantMessages = getActiveAssistantMessages(group)
  const activeAssistantMessage = activeAssistantMessages.at(-1) ?? null
  const requestMessageId = group.userMessage.id
  const groupRequestMessageIds = [requestMessageId, ...group.hiddenRequestMessageIds]
  const visibleToolCalls = getVisibleToolCallsForGroup({
    group,
    toolCalls: input.inlineToolCalls,
    activeRunId: input.activeRunId
  })
  const memorySummary = findRunMemorySummaryForRequests(input.runs, groupRequestMessageIds)
  const savedMemoryCount = visibleToolCalls.filter(
    (toolCall) => toolCall.toolName === 'remember' && toolCall.status === 'completed'
  ).length
  const failedRunError =
    activeAssistantMessage?.status === 'failed'
      ? (findLatestRunForRequests(
          input.runs,
          groupRequestMessageIds,
          (run) => run.status === 'failed'
        )?.error ?? null)
      : null

  const assistantMessageByTextBlockId = new Map<string, Message>()
  const activeAssistantTextBlocks: MessageTextBlockRecord[] = (() => {
    if (activeAssistantMessages.length === 0 || group.hideActiveBranchWhilePreparing) return []

    const textBlocks: MessageTextBlockRecord[] = []
    for (const assistantMessage of activeAssistantMessages) {
      for (const textBlock of resolveAssistantTextBlocks(assistantMessage)) {
        assistantMessageByTextBlockId.set(textBlock.id, assistantMessage)
        textBlocks.push(textBlock)
      }
    }
    return textBlocks
  })()

  const hasRunningToolCall = visibleToolCalls.some(
    (toolCall) => toolCall.status === 'preparing' || toolCall.status === 'running'
  )

  if (!group.userMessage.hidden) {
    rows.push({
      kind: 'group-user',
      key: `user:${requestMessageId}`,
      time: group.userMessage.createdAt,
      requestMessageId,
      scrollMessageId: requestMessageId,
      group
    })
  }

  if (responseCount > 1) {
    rows.push({
      kind: 'group-branch-navigation',
      key: `branch-navigation:${requestMessageId}`,
      time: group.userMessage.createdAt,
      requestMessageId,
      ...(activeBranch
        ? {
            activeAssistantMessageId: activeBranch.message.id,
            assistantMessageId: activeBranch.message.id
          }
        : {}),
      group
    })
  }

  for (const assistantMessage of activeAssistantMessages) {
    if (!assistantMessage.reasoning) continue
    rows.push({
      kind: 'group-thinking',
      key: `thinking:${assistantMessage.id}`,
      time: assistantMessage.createdAt,
      requestMessageId,
      scrollMessageId: activeAssistantTextBlocks.length === 0 ? assistantMessage.id : undefined,
      assistantMessageId: assistantMessage.id,
      group,
      assistantMessage
    })
  }

  const timelineItems = buildConversationGroupTimelineItems({
    hasMemoryRecall: Boolean(memorySummary),
    replyCount: responseCount,
    showPreparing: group.showPreparing && !input.subagentActive,
    showGenerating:
      activeAssistantMessage?.status === 'streaming' &&
      activeAssistantTextBlocks.length > 0 &&
      !hasRunningToolCall &&
      !input.subagentActive,
    activeAssistantTextBlocks,
    visibleToolCalls
  })
  const textBlocksById = new Map(
    activeAssistantTextBlocks.map((textBlock) => [textBlock.id, textBlock])
  )

  for (let index = 0; index < timelineItems.length; index += 1) {
    const item = timelineItems[index]!
    const nextItem = timelineItems[index + 1]

    if (item.kind === 'memory-recall' && memorySummary) {
      rows.push({
        kind: 'group-memory-recall',
        key: `memory-recall:${requestMessageId}`,
        time: group.userMessage.createdAt,
        requestMessageId,
        ...(activeAssistantMessage ? { assistantMessageId: activeAssistantMessage.id } : {}),
        group,
        entries: memorySummary.entries,
        recallDecision: memorySummary.recallDecision
      })
      continue
    }

    if (item.kind === 'tool-call') {
      const toolCall = visibleToolCalls.find((entry) => entry.id === item.toolCallId)
      if (!toolCall) continue
      rows.push({
        kind: 'group-tool-call',
        key: `tool:${toolCall.id}`,
        time: group.userMessage.createdAt,
        requestMessageId,
        ...(toolCall.assistantMessageId
          ? { assistantMessageId: toolCall.assistantMessageId }
          : activeAssistantMessage
            ? { assistantMessageId: activeAssistantMessage.id }
            : {}),
        group,
        toolCall
      })
      continue
    }

    if (item.kind === 'tool-call-group') {
      const toolCalls = item.toolCallIds
        .map((id) => visibleToolCalls.find((entry) => entry.id === id))
        .filter((toolCall): toolCall is ToolCall => toolCall != null)
      if (toolCalls.length === 0) continue
      rows.push({
        kind: 'group-tool-call-group',
        key: `tool-group:${requestMessageId}:${item.key}`,
        time: group.userMessage.createdAt,
        requestMessageId,
        ...(activeAssistantMessage ? { assistantMessageId: activeAssistantMessage.id } : {}),
        group,
        toolGroup: item.group,
        toolCalls
      })
      continue
    }

    if (item.kind === 'assistant-text-block' && activeAssistantMessage) {
      const textBlock = textBlocksById.get(item.textBlockId)
      if (!textBlock || !textBlock.content.trim()) continue
      const assistantMessage = assistantMessageByTextBlockId.get(item.textBlockId)
      if (!assistantMessage) continue
      const isLastTextBlock = activeAssistantTextBlocks.at(-1)?.id === item.textBlockId
      const nextToolCall =
        nextItem?.kind === 'tool-call'
          ? visibleToolCalls.find((entry) => entry.id === nextItem.toolCallId)
          : null
      const nextGroupHasRunning =
        nextItem?.kind === 'tool-call-group' &&
        nextItem.toolCallIds.some((id) => {
          const status = visibleToolCalls.find((entry) => entry.id === id)?.status
          return status === 'preparing' || status === 'running'
        })
      const isStreaming =
        input.isActiveGroup &&
        assistantMessage.id === activeAssistantMessage.id &&
        activeAssistantMessage.status === 'streaming' &&
        isLastTextBlock &&
        !hasRunningToolCall &&
        !input.subagentActive
      rows.push({
        kind: 'group-assistant-text-block',
        key: `assistant-text:${assistantMessage.id}:${textBlock.id}`,
        time: group.userMessage.createdAt,
        requestMessageId,
        scrollMessageId: assistantMessage.id,
        assistantMessageId: assistantMessage.id,
        group,
        assistantMessage,
        textBlock,
        hasRunningToolCall,
        isLastTextBlock,
        isStreaming,
        compactBottomSpacing:
          nextToolCall?.status === 'preparing' ||
          nextToolCall?.status === 'running' ||
          nextGroupHasRunning
      })
      continue
    }

    if (item.kind === 'generating') {
      rows.push({
        kind: 'group-generating',
        key: `generating:${requestMessageId}`,
        time: group.userMessage.createdAt,
        requestMessageId,
        ...(activeAssistantMessage ? { assistantMessageId: activeAssistantMessage.id } : {}),
        group
      })
      continue
    }

    if (item.kind === 'preparing') {
      rows.push({
        kind: 'group-preparing',
        key: `preparing:${requestMessageId}`,
        time: group.userMessage.createdAt,
        requestMessageId,
        scrollMessageId: requestMessageId,
        ...(activeAssistantMessage ? { assistantMessageId: activeAssistantMessage.id } : {}),
        group
      })
    }
  }

  if (
    activeAssistantMessage &&
    activeAssistantTextBlocks.length > 0 &&
    activeAssistantMessage.status !== 'streaming' &&
    !input.subagentActive
  ) {
    rows.push({
      kind: 'group-footer',
      key: `footer:${activeAssistantMessage.id}`,
      time: group.userMessage.createdAt,
      requestMessageId,
      assistantMessageId: activeAssistantMessage.id,
      group,
      assistantMessage: activeAssistantMessage,
      savedMemoryCount,
      failedRunError
    })
  }

  if (input.isActiveGroup && input.subagentActive) {
    rows.push({
      kind: 'group-subagent',
      key: `subagent:${requestMessageId}`,
      time: group.userMessage.createdAt,
      requestMessageId,
      ...(activeAssistantMessage ? { assistantMessageId: activeAssistantMessage.id } : {}),
      group
    })
  }

  return rows
}

export function buildMessageTimelineRows(
  input: BuildMessageTimelineRowsInput
): MessageTimelineRow[] {
  const blocks: Array<{ time: string; rows: MessageTimelineRow[] }> = [
    ...input.messageGroups.map((group) => {
      const isActiveGroup = isActiveRequestForGroup(group, input.activeRequestMessageId)
      return {
        time: group.userMessage.createdAt,
        rows: buildConversationGroupRows({
          group,
          inlineToolCalls: input.inlineToolCalls,
          runs: input.runs,
          activeRunId: input.activeRunId,
          isActiveGroup,
          subagentActive: input.subagentActive && isActiveGroup
        })
      }
    }),
    ...input.rootAssistantMessages.map((message) => ({
      time: message.createdAt,
      rows: [
        {
          kind: 'assistant-root' as const,
          key: message.id,
          time: message.createdAt,
          data: message,
          scrollMessageId: message.id
        }
      ]
    })),
    ...(input.pendingSteerMessage
      ? [
          {
            time: input.pendingSteerMessage.createdAt,
            rows: [
              {
                kind: 'pending-steer' as const,
                key: input.pendingSteerMessage.id,
                time: input.pendingSteerMessage.createdAt,
                data: input.pendingSteerMessage,
                scrollMessageId: input.pendingSteerMessage.id
              }
            ]
          }
        ]
      : []),
    ...input.orphanToolCalls.map((toolCall) => ({
      time: toolCall.startedAt,
      rows: [
        {
          kind: 'tool' as const,
          key: toolCall.id,
          time: toolCall.startedAt,
          data: toolCall
        }
      ]
    }))
  ]

  return blocks.sort(compareBlocks).flatMap((block) => block.rows)
}
