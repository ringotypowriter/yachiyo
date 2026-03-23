import type { Message, Thread, ToolCall } from '@renderer/app/types'
import {
  buildMessageTreeMaps,
  collectMessagePath,
  sortMessagesByCreatedAt
} from '../../../../../shared/yachiyo/threadTree.ts'

export interface MessageGroupBranch {
  message: Message
  isActive: boolean
  label?: string
}

export interface MessageGroup {
  userMessage: Message
  assistantBranches: MessageGroupBranch[]
  activeBranchIndex: number
  hideActiveBranchWhilePreparing: boolean
  showPreparing: boolean
}

export function getRootAssistantMessages(messages: Message[]): Message[] {
  return sortMessagesByCreatedAt(
    messages.filter((message) => message.role === 'assistant' && !message.parentMessageId)
  )
}

export function getVisibleToolCallsForGroup(input: {
  group: MessageGroup
  toolCalls: ToolCall[]
  activeRunId?: string | null
}): ToolCall[] {
  const requestMessageId = input.group.userMessage.id
  const hiddenActiveAssistantId =
    input.group.hideActiveBranchWhilePreparing && input.group.activeBranchIndex >= 0
      ? input.group.assistantBranches[input.group.activeBranchIndex]?.message.id
      : undefined
  const knownAssistantIds = new Set(
    input.group.assistantBranches.map((branch) => branch.message.id)
  )
  const visibleAssistantIds = new Set(
    input.group.assistantBranches
      .filter(
        (branch) =>
          (!input.group.hideActiveBranchWhilePreparing && branch.isActive) ||
          branch.message.status !== 'completed'
      )
      .map((branch) => branch.message.id)
  )

  return input.toolCalls
    .filter((toolCall) => {
      if (toolCall.requestMessageId !== requestMessageId) {
        return false
      }

      if (input.group.showPreparing && input.activeRunId && toolCall.runId !== input.activeRunId) {
        return false
      }

      if (!toolCall.assistantMessageId || !knownAssistantIds.has(toolCall.assistantMessageId)) {
        return true
      }

      if (
        hiddenActiveAssistantId &&
        toolCall.assistantMessageId === hiddenActiveAssistantId &&
        toolCall.status === 'running'
      ) {
        return true
      }

      if (hiddenActiveAssistantId) {
        return false
      }

      return visibleAssistantIds.has(toolCall.assistantMessageId)
    })
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
}

export function partitionToolCallsForGroups(input: {
  groups: MessageGroup[]
  toolCalls: ToolCall[]
}): { inlineToolCalls: ToolCall[]; orphanToolCalls: ToolCall[] } {
  const visibleRequestIds = new Set(input.groups.map((group) => group.userMessage.id))

  return {
    inlineToolCalls: input.toolCalls.filter(
      (toolCall) => toolCall.requestMessageId && visibleRequestIds.has(toolCall.requestMessageId)
    ),
    // Only legacy tool records without request anchors fall back to top-level rendering.
    orphanToolCalls: input.toolCalls.filter((toolCall) => !toolCall.requestMessageId)
  }
}

function truncatePathAtRequest(path: Message[], requestMessageId: string | null): Message[] {
  if (!requestMessageId) {
    return path
  }

  const endIndex = path.findIndex((message) => message.id === requestMessageId)
  return endIndex >= 0 ? path.slice(0, endIndex + 1) : path
}

export function buildMessageGroups(input: {
  thread: Thread
  messages: Message[]
  runPhase: 'idle' | 'preparing' | 'streaming'
  activeRequestMessageId: string | null
}): MessageGroup[] {
  const messages = sortMessagesByCreatedAt(input.messages)
  const maps = buildMessageTreeMaps(messages)
  const resolvedHeadMessageId =
    input.thread.headMessageId && maps.byId.has(input.thread.headMessageId)
      ? input.thread.headMessageId
      : messages.at(-1)?.id

  if (!resolvedHeadMessageId) {
    return []
  }

  const fullPath = collectMessagePath(messages, resolvedHeadMessageId)
  const visiblePath =
    input.runPhase === 'idle'
      ? fullPath
      : truncatePathAtRequest(fullPath, input.activeRequestMessageId)
  const activeAssistantIdsByRequest = new Map<string, string>()

  for (let index = 0; index < fullPath.length - 1; index += 1) {
    const current = fullPath[index]
    const next = fullPath[index + 1]

    if (
      current?.role === 'user' &&
      next?.role === 'assistant' &&
      next.parentMessageId === current.id
    ) {
      activeAssistantIdsByRequest.set(current.id, next.id)
    }
  }

  return visiblePath
    .filter((message): message is Message => message.role === 'user')
    .map((userMessage) => {
      const assistantMessages = (maps.childrenByParent.get(userMessage.id) ?? []).filter(
        (message): message is Message => message.role === 'assistant'
      )
      const activeAssistantIdFromPath = activeAssistantIdsByRequest.get(userMessage.id)
      const activeAssistantFromPath = assistantMessages.find(
        (message) => message.id === activeAssistantIdFromPath
      )
      const newestAssistant = assistantMessages.at(-1)
      const shouldPreferNewestAssistant =
        input.runPhase === 'streaming' &&
        input.activeRequestMessageId === userMessage.id &&
        newestAssistant &&
        newestAssistant.id !== activeAssistantIdFromPath &&
        (!activeAssistantFromPath ||
          newestAssistant.createdAt.localeCompare(activeAssistantFromPath.createdAt) >= 0)
      const selectedAssistantId = shouldPreferNewestAssistant
        ? newestAssistant?.id
        : (activeAssistantIdFromPath ?? newestAssistant?.id)
      const activeBranchIndex = assistantMessages.findIndex(
        (message) => message.id === selectedAssistantId
      )

      return {
        userMessage,
        assistantBranches: assistantMessages.map((message, index) => ({
          message,
          isActive: index === activeBranchIndex
        })),
        activeBranchIndex,
        hideActiveBranchWhilePreparing:
          input.runPhase === 'preparing' &&
          input.activeRequestMessageId === userMessage.id &&
          assistantMessages.length > 0,
        showPreparing:
          input.runPhase === 'preparing' && input.activeRequestMessageId === userMessage.id
      }
    })
}
