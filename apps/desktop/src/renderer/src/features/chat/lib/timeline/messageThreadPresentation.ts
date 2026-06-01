import type { Message, RunRecord, Thread, ToolCall } from '@renderer/app/types'
import {
  buildMessageTreeMaps,
  collectMessagePath,
  sortMessagesByCreatedAt
} from '@yachiyo/shared/threadTree'
import { compareToolCallsChronologically } from '@yachiyo/shared/toolCallOrder'

export interface MessageGroupBranch {
  message: Message
  isActive: boolean
  label?: string
}

export interface MessageGroup {
  userMessage: Message
  assistantBranches: MessageGroupBranch[]
  activeAssistantMessages: Message[]
  hiddenRequestMessageIds: string[]
  userSteerMessages: Message[]
  activeBranchIndex: number
  hideActiveBranchWhilePreparing: boolean
  showPreparing: boolean
}

export function isVisibleTimelineMessage(message: Message): boolean {
  return message.hidden !== true
}

function isLegacyHiddenFollowUpMessage(input: {
  message: Message
  messagesById: ReadonlyMap<string, Message>
  runByRequestMessageId: ReadonlyMap<string, RunRecord>
}): boolean {
  const parent = input.message.parentMessageId
    ? input.messagesById.get(input.message.parentMessageId)
    : undefined
  if (!parent || parent.role !== 'assistant' || !isVisibleTimelineMessage(parent)) return false

  const run = input.runByRequestMessageId.get(input.message.id)
  if (!run) return false

  // Legacy hidden steers update the original run's request id, so the run
  // still predates the assistant message that they branch from. Legacy hidden
  // follow-ups start a new run after that completed assistant message.
  return run.createdAt.localeCompare(parent.createdAt) > 0
}

function collectHiddenFollowUpMessageIds(input: {
  messages: readonly Message[]
  messagesById: ReadonlyMap<string, Message>
  runs: readonly RunRecord[]
}): Set<string> {
  const runByRequestMessageId = new Map<string, RunRecord>()
  for (const run of input.runs) {
    if (run.requestMessageId) runByRequestMessageId.set(run.requestMessageId, run)
  }

  const hiddenFollowUpMessageIds = new Set<string>()
  for (const message of input.messages) {
    if (message.role !== 'user' || message.hidden !== true) continue
    if (message.turnContext?.hiddenRequestKind === 'steer') continue
    if (
      message.turnContext?.hiddenRequestKind === 'follow-up' ||
      isLegacyHiddenFollowUpMessage({
        message,
        messagesById: input.messagesById,
        runByRequestMessageId
      })
    ) {
      hiddenFollowUpMessageIds.add(message.id)
    }
  }

  return hiddenFollowUpMessageIds
}

function isHiddenFollowUpMessage(
  message: Message,
  hiddenFollowUpMessageIds: ReadonlySet<string>
): boolean {
  return (
    message.role === 'user' && message.hidden === true && hiddenFollowUpMessageIds.has(message.id)
  )
}

function isTimelineGroupPathMessage(
  message: Message,
  hiddenFollowUpMessageIds: ReadonlySet<string>
): boolean {
  return (
    isVisibleTimelineMessage(message) || isHiddenFollowUpMessage(message, hiddenFollowUpMessageIds)
  )
}

function isRequestBoundaryMessage(
  message: Message,
  hiddenFollowUpMessageIds: ReadonlySet<string>
): boolean {
  return message.role === 'user' && isTimelineGroupPathMessage(message, hiddenFollowUpMessageIds)
}

export function isActiveRequestForGroup(
  group: MessageGroup,
  activeRequestMessageId: string | null
): boolean {
  return (
    activeRequestMessageId !== null &&
    (group.userMessage.id === activeRequestMessageId ||
      group.hiddenRequestMessageIds.includes(activeRequestMessageId) ||
      group.userSteerMessages.some((message) => message.id === activeRequestMessageId))
  )
}

export function getRootAssistantMessages(messages: Message[]): Message[] {
  return sortMessagesByCreatedAt(
    messages.filter(
      (message) =>
        isVisibleTimelineMessage(message) &&
        message.role === 'assistant' &&
        !message.parentMessageId
    )
  )
}

export function getQueuedFollowUpMessage(input: {
  thread: Thread
  messages: Message[]
}): Message | null {
  const queuedMessageId = input.thread.queuedFollowUpMessageId
  if (!queuedMessageId) return null

  return (
    input.messages.find(
      (message) => message.id === queuedMessageId && isVisibleTimelineMessage(message)
    ) ?? null
  )
}

export function getTimelineMessages(input: { thread: Thread; messages: Message[] }): Message[] {
  const queuedMessageId = input.thread.queuedFollowUpMessageId
  if (!queuedMessageId) return input.messages

  let removedQueuedMessage = false
  const messages = input.messages.filter((message) => {
    if (message.id !== queuedMessageId) return true
    removedQueuedMessage = true
    return false
  })

  return removedQueuedMessage ? messages : input.messages
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
  const requestMessageIds = new Set([
    input.group.userMessage.id,
    ...input.group.hiddenRequestMessageIds,
    ...input.group.userSteerMessages.map((message) => message.id)
  ])
  const activeAssistantMessage =
    input.group.activeAssistantMessages.at(-1) ??
    (input.group.activeBranchIndex >= 0
      ? input.group.assistantBranches[input.group.activeBranchIndex]?.message
      : undefined)
  const hiddenActiveAssistantId =
    input.group.hideActiveBranchWhilePreparing && input.group.activeBranchIndex >= 0
      ? input.group.assistantBranches[input.group.activeBranchIndex]?.message.id
      : undefined
  const knownAssistantIds = new Set([
    ...input.group.assistantBranches.map((branch) => branch.message.id),
    ...input.group.activeAssistantMessages.map((message) => message.id)
  ])
  // Keep failed / stopped branches visible so their anchored tool calls
  // stay inspectable even when the user has pinned the group to an older
  // successful reply. Without this, the retry's tool trace would vanish
  // after the user navigates back to the original answer.
  const visibleAssistantIds = new Set([
    ...input.group.activeAssistantMessages.map((message) => message.id),
    ...input.group.assistantBranches
      .filter(
        (branch) =>
          (!input.group.hideActiveBranchWhilePreparing && branch.isActive) ||
          branch.message.status === 'streaming' ||
          branch.message.status === 'failed' ||
          branch.message.status === 'stopped'
      )
      .map((branch) => branch.message.id)
  ])
  const responseMessageToolOrder = collectResponseMessageToolOrder(
    activeAssistantMessage?.responseMessages
  )

  return input.toolCalls
    .filter((toolCall) => {
      if (!toolCall.requestMessageId || !requestMessageIds.has(toolCall.requestMessageId)) {
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
          input.group.activeAssistantMessages.at(-1)?.id ??
          (input.group.activeBranchIndex >= 0
            ? input.group.assistantBranches[input.group.activeBranchIndex]?.message.id
            : undefined)
        const activeAssistantIds = new Set([
          ...input.group.activeAssistantMessages.map((message) => message.id),
          ...(activeBranchMessageId ? [activeBranchMessageId] : [])
        ])
        if (!toolCall.assistantMessageId || !activeAssistantIds.has(toolCall.assistantMessageId)) {
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
  const visibleRequestIds = new Set(
    input.groups.flatMap((group) => [
      group.userMessage.id,
      ...group.hiddenRequestMessageIds,
      ...group.userSteerMessages.map((message) => message.id)
    ])
  )

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

function includeStreamingHiddenAssistantInPath(input: {
  path: Message[]
  messagesById: Map<string, Message>
  childrenByParent: Map<string | null, Message[]>
  runPhase: 'idle' | 'preparing' | 'streaming'
  activeRequestMessageId: string | null
}): Message[] {
  if (input.runPhase !== 'streaming' || !input.activeRequestMessageId) {
    return input.path
  }

  const activeRequest = input.messagesById.get(input.activeRequestMessageId)
  if (
    !activeRequest ||
    activeRequest.role !== 'user' ||
    activeRequest.hidden !== true ||
    !input.path.some((message) => message.id === activeRequest.id)
  ) {
    return input.path
  }

  const streamingAssistant = (input.childrenByParent.get(activeRequest.id) ?? [])
    .filter(
      (message): message is Message =>
        message.role === 'assistant' &&
        message.status === 'streaming' &&
        isVisibleTimelineMessage(message)
    )
    .at(-1)

  if (!streamingAssistant || input.path.some((message) => message.id === streamingAssistant.id)) {
    return input.path
  }

  return [...input.path, streamingAssistant]
}

interface CachedGroup {
  userMessage: Message
  assistantMessages: readonly Message[]
  activeAssistantMessages: readonly Message[]
  hiddenRequestMessageIds: readonly string[]
  userSteerMessages: readonly Message[]
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

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function isUserSteerMessage(input: {
  message: Message
  messagesById: ReadonlyMap<string, Message>
  rootUserMessageId?: string
}): boolean {
  if (input.message.role !== 'user' || !isVisibleTimelineMessage(input.message)) return false

  let parent = input.message.parentMessageId
    ? input.messagesById.get(input.message.parentMessageId)
    : undefined
  if (!parent || parent.role !== 'user' || !isVisibleTimelineMessage(parent)) return false
  if (!input.rootUserMessageId) return true

  while (parent && parent.role === 'user' && isVisibleTimelineMessage(parent)) {
    if (parent.id === input.rootUserMessageId) return true
    parent = parent.parentMessageId ? input.messagesById.get(parent.parentMessageId) : undefined
  }

  return false
}

function getFirstVisibleAssistantIdAfterUser(input: {
  fullPath: Message[]
  messagesById: ReadonlyMap<string, Message>
  hiddenFollowUpMessageIds: ReadonlySet<string>
  userMessageId: string
}): string | undefined {
  const userIndex = input.fullPath.findIndex((message) => message.id === input.userMessageId)
  if (userIndex < 0) {
    return undefined
  }

  for (let index = userIndex + 1; index < input.fullPath.length; index += 1) {
    const message = input.fullPath[index]!
    if (
      isUserSteerMessage({
        message,
        messagesById: input.messagesById,
        rootUserMessageId: input.userMessageId
      })
    ) {
      continue
    }
    if (isRequestBoundaryMessage(message, input.hiddenFollowUpMessageIds)) {
      return undefined
    }
    if (message.role === 'assistant' && isVisibleTimelineMessage(message)) {
      return message.id
    }
  }

  return undefined
}

function collectUserSteerMessagesForGroup(input: {
  fullPath: Message[]
  messagesById: ReadonlyMap<string, Message>
  userMessageId: string
}): Message[] {
  const userIndex = input.fullPath.findIndex((message) => message.id === input.userMessageId)
  if (userIndex < 0) {
    return []
  }

  const userSteerMessages: Message[] = []
  for (let index = userIndex + 1; index < input.fullPath.length; index += 1) {
    const message = input.fullPath[index]!
    if (
      !isUserSteerMessage({
        message,
        messagesById: input.messagesById,
        rootUserMessageId: input.userMessageId
      })
    ) {
      break
    }
    userSteerMessages.push(message)
  }

  return userSteerMessages
}

function collectHiddenRequestMessageIdsForGroup(input: {
  fullPath: Message[]
  hiddenFollowUpMessageIds: ReadonlySet<string>
  userMessageId: string
}): string[] {
  const userIndex = input.fullPath.findIndex((message) => message.id === input.userMessageId)
  if (userIndex < 0) {
    return []
  }

  const hiddenRequestMessageIds: string[] = []
  for (let index = userIndex + 1; index < input.fullPath.length; index += 1) {
    const message = input.fullPath[index]!
    if (isRequestBoundaryMessage(message, input.hiddenFollowUpMessageIds)) {
      break
    }
    if (message.role === 'user' && message.hidden === true) {
      hiddenRequestMessageIds.push(message.id)
    }
  }

  return hiddenRequestMessageIds
}

function collectActiveAssistantMessagesForGroup(input: {
  allMessages: Message[]
  fullPath: Message[]
  hiddenFollowUpMessageIds: ReadonlySet<string>
  selectedAssistantId?: string
  userMessageId: string
}): Message[] {
  if (!input.selectedAssistantId) {
    return []
  }

  const selectedAssistant = input.allMessages.find(
    (message) => message.id === input.selectedAssistantId && message.role === 'assistant'
  )
  if (!selectedAssistant || !isVisibleTimelineMessage(selectedAssistant)) {
    return []
  }

  const selectedIndex = input.fullPath.findIndex((message) => message.id === selectedAssistant.id)
  if (selectedIndex < 0) {
    return [selectedAssistant]
  }

  const activeAssistantMessages: Message[] = []
  for (let index = selectedIndex; index < input.fullPath.length; index += 1) {
    const message = input.fullPath[index]!
    if (
      index > selectedIndex &&
      isRequestBoundaryMessage(message, input.hiddenFollowUpMessageIds)
    ) {
      break
    }
    if (message.role === 'assistant' && isVisibleTimelineMessage(message)) {
      activeAssistantMessages.push(message)
    }
  }

  return activeAssistantMessages.length > 0 ? activeAssistantMessages : [selectedAssistant]
}

function getVisibleUserAncestorId(input: {
  messagesById: Map<string, Message>
  messageId: string
}): string | undefined {
  let current = input.messagesById.get(input.messageId)
  const visited = new Set<string>()

  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    if (current.role === 'user' && isVisibleTimelineMessage(current)) {
      return current.id
    }
    current = current.parentMessageId ? input.messagesById.get(current.parentMessageId) : undefined
  }

  return undefined
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
  runs?: RunRecord[]
  runPhase: 'idle' | 'preparing' | 'streaming'
  activeRequestMessageId: string | null
}): MessageGroup[] {
  const allMessages = sortMessagesByCreatedAt(input.messages)
  const maps = buildMessageTreeMaps(allMessages)
  const hiddenFollowUpMessageIds = collectHiddenFollowUpMessageIds({
    messages: allMessages,
    messagesById: maps.byId,
    runs: input.runs ?? []
  })
  const visibleMessages = allMessages.filter(isVisibleTimelineMessage)
  const visibleMaps = buildMessageTreeMaps(visibleMessages)
  const resolvedHeadMessageId =
    input.thread.headMessageId && maps.byId.has(input.thread.headMessageId)
      ? input.thread.headMessageId
      : allMessages.at(-1)?.id

  if (!resolvedHeadMessageId) {
    return []
  }

  const fullPath = includeStreamingHiddenAssistantInPath({
    path: collectMessagePath(allMessages, resolvedHeadMessageId),
    messagesById: maps.byId,
    childrenByParent: maps.childrenByParent,
    runPhase: input.runPhase,
    activeRequestMessageId: input.activeRequestMessageId
  })
  const visiblePath =
    input.runPhase === 'idle'
      ? fullPath.filter((message) => isTimelineGroupPathMessage(message, hiddenFollowUpMessageIds))
      : truncatePathAtRequest(fullPath, input.activeRequestMessageId).filter((message) =>
          isTimelineGroupPathMessage(message, hiddenFollowUpMessageIds)
        )
  const activeAssistantIdsByRequest = new Map<string, string>()
  const activeRequestMessage = input.activeRequestMessageId
    ? maps.byId.get(input.activeRequestMessageId)
    : undefined
  const activeHiddenRequestUserId =
    activeRequestMessage?.hidden === true &&
    !isHiddenFollowUpMessage(activeRequestMessage, hiddenFollowUpMessageIds)
      ? getVisibleUserAncestorId({
          messagesById: maps.byId,
          messageId: input.activeRequestMessageId!
        })
      : undefined

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
    if (isUserSteerMessage({ message, messagesById: maps.byId })) continue
    const userMessage = message
    const userSteerMessages = collectUserSteerMessagesForGroup({
      fullPath,
      messagesById: maps.byId,
      userMessageId: userMessage.id
    })

    const assistantMessages = (visibleMaps.childrenByParent.get(userMessage.id) ?? []).filter(
      (m): m is Message => m.role === 'assistant'
    )
    const activeAssistantIdFromPath =
      activeAssistantIdsByRequest.get(userMessage.id) ??
      getFirstVisibleAssistantIdAfterUser({
        fullPath,
        messagesById: maps.byId,
        hiddenFollowUpMessageIds,
        userMessageId: userMessage.id
      })
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
    const activeAssistantMessages = collectActiveAssistantMessagesForGroup({
      allMessages,
      fullPath,
      hiddenFollowUpMessageIds,
      selectedAssistantId,
      userMessageId: userMessage.id
    })
    const hiddenRequestMessageIds = collectHiddenRequestMessageIdsForGroup({
      fullPath,
      hiddenFollowUpMessageIds,
      userMessageId: userMessage.id
    })
    const activeBranchIndex = assistantMessages.findIndex((m) => m.id === selectedAssistantId)
    const hideActiveBranchWhilePreparing =
      input.runPhase === 'preparing' &&
      input.activeRequestMessageId === userMessage.id &&
      assistantMessages.length > 0
    const showPreparing =
      input.runPhase === 'preparing' &&
      (input.activeRequestMessageId === userMessage.id ||
        activeHiddenRequestUserId === userMessage.id ||
        userSteerMessages.some((steerMessage) => steerMessage.id === input.activeRequestMessageId))

    const prev = prevCache?.byUserMessageId.get(userMessage.id)
    if (
      prev &&
      prev.userMessage === userMessage &&
      prev.activeBranchIndex === activeBranchIndex &&
      prev.hideActiveBranchWhilePreparing === hideActiveBranchWhilePreparing &&
      prev.showPreparing === showPreparing &&
      sameAssistantMessages(prev.assistantMessages, assistantMessages) &&
      sameAssistantMessages(prev.activeAssistantMessages, activeAssistantMessages) &&
      sameStringArray(prev.hiddenRequestMessageIds, hiddenRequestMessageIds) &&
      sameAssistantMessages(prev.userSteerMessages, userSteerMessages)
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
      activeAssistantMessages,
      hiddenRequestMessageIds,
      userSteerMessages,
      activeBranchIndex,
      hideActiveBranchWhilePreparing,
      showPreparing
    }

    nextByUserMessageId.set(userMessage.id, {
      userMessage,
      assistantMessages,
      activeAssistantMessages,
      hiddenRequestMessageIds,
      userSteerMessages,
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
