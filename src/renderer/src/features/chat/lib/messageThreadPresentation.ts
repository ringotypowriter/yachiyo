import type { Message, Thread, ToolCall } from '@renderer/app/types'
import {
  buildMessageTreeMaps,
  collectMessagePath,
  sortMessagesByCreatedAt
} from '../../../../../shared/yachiyo/threadTree.ts'
import { compareToolCallsChronologically } from '../../../../../shared/yachiyo/toolCallOrder.ts'

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

function collectResponseMessageToolOrder(responseMessages?: unknown[]): Map<string, number> {
  if (!responseMessages?.length) {
    return new Map()
  }

  const toolOrder = new Map<string, number>()

  for (const message of responseMessages) {
    if (
      !message ||
      typeof message !== 'object' ||
      !('role' in message) ||
      message.role !== 'assistant' ||
      !('content' in message) ||
      !Array.isArray(message.content)
    ) {
      continue
    }

    for (const part of message.content) {
      if (
        !part ||
        typeof part !== 'object' ||
        !('type' in part) ||
        part.type !== 'tool-call' ||
        !('toolCallId' in part) ||
        typeof part.toolCallId !== 'string' ||
        toolOrder.has(part.toolCallId)
      ) {
        continue
      }

      toolOrder.set(part.toolCallId, toolOrder.size)
    }
  }

  return toolOrder
}

export function getVisibleToolCallsForGroup(input: {
  group: MessageGroup
  toolCalls: ToolCall[]
  activeRunId?: string | null
}): ToolCall[] {
  const requestMessageId = input.group.userMessage.id
  const activeAssistantMessage =
    input.group.activeBranchIndex >= 0
      ? input.group.assistantBranches[input.group.activeBranchIndex]?.message
      : undefined
  const hiddenActiveAssistantId =
    input.group.hideActiveBranchWhilePreparing && input.group.activeBranchIndex >= 0
      ? input.group.assistantBranches[input.group.activeBranchIndex]?.message.id
      : undefined
  const knownAssistantIds = new Set(
    input.group.assistantBranches.map((branch) => branch.message.id)
  )
  // Keep failed / stopped branches visible so their anchored tool calls
  // stay inspectable even when the user has pinned the group to an older
  // successful reply. Without this, the retry's tool trace would vanish
  // after the user navigates back to the original answer.
  const visibleAssistantIds = new Set(
    input.group.assistantBranches
      .filter(
        (branch) =>
          (!input.group.hideActiveBranchWhilePreparing && branch.isActive) ||
          branch.message.status === 'streaming' ||
          branch.message.status === 'failed' ||
          branch.message.status === 'stopped'
      )
      .map((branch) => branch.message.id)
  )
  const responseMessageToolOrder = collectResponseMessageToolOrder(
    activeAssistantMessage?.responseMessages
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
        if (toolCall.status === 'preparing' || toolCall.status === 'running') return true
        if (input.activeRunId) return toolCall.runId === input.activeRunId
        return !activeAssistantMessage || activeAssistantMessage.status !== 'completed'
      }

      if (
        hiddenActiveAssistantId &&
        toolCall.assistantMessageId === hiddenActiveAssistantId &&
        (toolCall.status === 'preparing' || toolCall.status === 'running')
      ) {
        return true
      }

      if (hiddenActiveAssistantId) {
        return false
      }

      if (input.activeRunId && toolCall.runId && toolCall.runId !== input.activeRunId) {
        const activeBranchMessageId =
          input.group.activeBranchIndex >= 0
            ? input.group.assistantBranches[input.group.activeBranchIndex]?.message.id
            : undefined
        if (toolCall.assistantMessageId !== activeBranchMessageId) {
          return false
        }
      }

      return visibleAssistantIds.has(toolCall.assistantMessageId)
    })
    .sort((left, right) => {
      const leftResponseOrder = responseMessageToolOrder.get(left.id)
      const rightResponseOrder = responseMessageToolOrder.get(right.id)

      if (leftResponseOrder !== undefined && rightResponseOrder !== undefined) {
        return leftResponseOrder - rightResponseOrder
      }

      return compareToolCallsChronologically(left, right)
    })
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

interface CachedGroup {
  userMessage: Message
  assistantMessages: readonly Message[]
  activeBranchIndex: number
  hideActiveBranchWhilePreparing: boolean
  showPreparing: boolean
  group: MessageGroup
}

interface ThreadGroupCache {
  byUserMessageId: Map<string, CachedGroup>
  lastResult: MessageGroup[]
}

// Module-level per-thread cache so repeated calls during streaming can
// reuse MessageGroup object identities for user requests whose inputs
// didn't change. Without this, every token delta produces a fresh set of
// group objects, breaking React.memo on ThreadConversationGroup for
// every group — not just the streaming one.
const groupCacheByThreadId = new Map<string, ThreadGroupCache>()

function sameAssistantMessages(a: readonly Message[], b: readonly Message[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function sameGroupArray(a: MessageGroup[], b: MessageGroup[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
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

  const threadId = input.thread.id
  const prevCache = groupCacheByThreadId.get(threadId)
  const nextByUserMessageId = new Map<string, CachedGroup>()
  const nextGroups: MessageGroup[] = []

  for (const message of visiblePath) {
    if (message.role !== 'user') continue
    const userMessage = message

    const assistantMessages = (maps.childrenByParent.get(userMessage.id) ?? []).filter(
      (m): m is Message => m.role === 'assistant'
    )
    const activeAssistantIdFromPath = activeAssistantIdsByRequest.get(userMessage.id)
    const activeAssistantFromPath = assistantMessages.find(
      (m) => m.id === activeAssistantIdFromPath
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
    const activeBranchIndex = assistantMessages.findIndex((m) => m.id === selectedAssistantId)
    const hideActiveBranchWhilePreparing =
      input.runPhase === 'preparing' &&
      input.activeRequestMessageId === userMessage.id &&
      assistantMessages.length > 0
    const showPreparing =
      input.runPhase === 'preparing' && input.activeRequestMessageId === userMessage.id

    const prev = prevCache?.byUserMessageId.get(userMessage.id)
    if (
      prev &&
      prev.userMessage === userMessage &&
      prev.activeBranchIndex === activeBranchIndex &&
      prev.hideActiveBranchWhilePreparing === hideActiveBranchWhilePreparing &&
      prev.showPreparing === showPreparing &&
      sameAssistantMessages(prev.assistantMessages, assistantMessages)
    ) {
      nextByUserMessageId.set(userMessage.id, prev)
      nextGroups.push(prev.group)
      continue
    }

    const group: MessageGroup = {
      userMessage,
      assistantBranches: assistantMessages.map((m, index) => ({
        message: m,
        isActive: index === activeBranchIndex
      })),
      activeBranchIndex,
      hideActiveBranchWhilePreparing,
      showPreparing
    }

    nextByUserMessageId.set(userMessage.id, {
      userMessage,
      assistantMessages,
      activeBranchIndex,
      hideActiveBranchWhilePreparing,
      showPreparing,
      group
    })
    nextGroups.push(group)
  }

  const result =
    prevCache && sameGroupArray(prevCache.lastResult, nextGroups)
      ? prevCache.lastResult
      : nextGroups
  groupCacheByThreadId.set(threadId, {
    byUserMessageId: nextByUserMessageId,
    lastResult: result
  })
  return result
}
