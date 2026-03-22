import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  MessageRecord,
  SaveThreadInput,
  SaveThreadResult,
  ThreadArchivedEvent,
  ThreadCreatedEvent,
  ThreadDeletedEvent,
  ThreadRecord,
  ThreadRestoredEvent,
  ThreadSnapshot,
  ThreadStateReplacedEvent,
  ThreadUpdatedEvent,
  ToolCallRecord
} from '../../../../shared/yachiyo/protocol.ts'
import { summarizeMessageInput } from '../../../../shared/yachiyo/messageContent.ts'
import {
  collectDescendantIds,
  collectMessagePath,
  pickLatestLeafId,
  pickReplacementHeadId,
  sortMessagesByCreatedAt
} from '../../../../shared/yachiyo/threadTree.ts'
import type { MemoryService } from '../../services/memory/memoryService.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import {
  DEFAULT_THREAD_TITLE,
  type CreateId,
  type EmitServerEvent,
  type Timestamp
} from './shared.ts'

interface ThreadDomainDeps {
  storage: YachiyoStorage
  createId: CreateId
  timestamp: Timestamp
  emit: EmitServerEvent
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  cloneThreadWorkspace: (sourceThreadId: string, targetThreadId: string) => Promise<string>
  deleteThreadWorkspace: (threadId: string) => Promise<void>
  memoryService: MemoryService
  loadThreadMessages: (threadId: string) => MessageRecord[]
  requireThread: (threadId: string) => ThreadRecord
  isThreadRunning: (threadId: string) => boolean
}

export interface RetryRequestResolution {
  requestMessage: MessageRecord
  sourceAssistantMessage?: MessageRecord
}

function resolveActiveAssistantForRequest(
  thread: ThreadRecord,
  messages: MessageRecord[],
  requestMessageId: string
): MessageRecord | undefined {
  const activePath =
    thread.headMessageId && messages.some((message) => message.id === thread.headMessageId)
      ? collectMessagePath(messages, thread.headMessageId)
      : []
  const requestIndex = activePath.findIndex((message) => message.id === requestMessageId)
  const pathAssistant = requestIndex >= 0 ? activePath[requestIndex + 1] : undefined

  if (pathAssistant?.role === 'assistant' && pathAssistant.parentMessageId === requestMessageId) {
    return pathAssistant
  }

  return messages
    .filter(
      (message): message is MessageRecord =>
        message.role === 'assistant' && message.parentMessageId === requestMessageId
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1)
}

export function resolveRetryRequest(
  thread: ThreadRecord,
  messages: MessageRecord[],
  messageId: string
): RetryRequestResolution {
  const target = messages.find((message) => message.id === messageId)

  if (!target) {
    throw new Error(`Unknown message: ${messageId}`)
  }

  if (target.role === 'user') {
    const sourceAssistantMessage = resolveActiveAssistantForRequest(thread, messages, target.id)

    return {
      requestMessage: target,
      ...(sourceAssistantMessage ? { sourceAssistantMessage } : {})
    }
  }

  if (!target.parentMessageId) {
    throw new Error('This message cannot be retried.')
  }

  const requestMessage = messages.find((message) => message.id === target.parentMessageId)
  if (!requestMessage || requestMessage.role !== 'user') {
    throw new Error('This message cannot be retried.')
  }

  return {
    requestMessage,
    sourceAssistantMessage: target
  }
}

function deriveBranchTitle(thread: ThreadRecord, branchPoint: MessageRecord): string {
  if (thread.title !== DEFAULT_THREAD_TITLE) {
    return thread.title
  }

  const titleSource = summarizeMessageInput(branchPoint)
  return titleSource ? titleSource.slice(0, 60) : DEFAULT_THREAD_TITLE
}

export class YachiyoServerThreadDomain {
  private readonly deps: ThreadDomainDeps

  constructor(deps: ThreadDomainDeps) {
    this.deps = deps
  }

  async createThread(input: { workspacePath?: string } = {}): Promise<ThreadRecord> {
    const timestamp = this.deps.timestamp()
    const workspacePath = input.workspacePath?.trim() ? resolve(input.workspacePath) : undefined
    const thread: ThreadRecord = {
      id: this.deps.createId(),
      title: DEFAULT_THREAD_TITLE,
      updatedAt: timestamp,
      ...(workspacePath ? { workspacePath } : {})
    }

    if (workspacePath) {
      await mkdir(workspacePath, { recursive: true })
    } else {
      await this.deps.ensureThreadWorkspace(thread.id)
    }
    this.deps.storage.createThread({ thread, createdAt: timestamp })

    this.deps.emit<ThreadCreatedEvent>({
      type: 'thread.created',
      threadId: thread.id,
      thread
    })

    return thread
  }

  async updateWorkspace(input: {
    threadId: string
    workspacePath?: string | null
  }): Promise<ThreadRecord> {
    const thread = this.deps.requireThread(input.threadId)
    if (this.deps.isThreadRunning(thread.id)) {
      throw new Error('Cannot change the workspace while this thread is running.')
    }

    const messages = this.loadThreadMessages(thread.id)
    const threadCreatedAt = this.deps.storage.getThreadCreatedAt(thread.id)
    const hasThreadLocalMessages =
      messages.length > 0 &&
      (!threadCreatedAt ||
        messages.some((message) => message.createdAt.localeCompare(threadCreatedAt) >= 0))
    if (hasThreadLocalMessages) {
      throw new Error('Workspace can only be changed before the first message is sent.')
    }

    const workspacePath = input.workspacePath?.trim()
      ? resolve(input.workspacePath.trim())
      : undefined

    if (workspacePath) {
      await mkdir(workspacePath, { recursive: true })
    }

    const updatedThread: ThreadRecord = {
      ...thread,
      updatedAt: this.deps.timestamp(),
      ...(workspacePath ? { workspacePath } : {})
    }

    if (!workspacePath) {
      delete updatedThread.workspacePath
    }

    this.deps.storage.updateThread(updatedThread)
    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    return updatedThread
  }

  renameThread(input: { threadId: string; title: string }): ThreadRecord {
    const title = input.title.trim()
    if (!title) {
      throw new Error('Thread title cannot be empty.')
    }

    const thread = this.deps.requireThread(input.threadId)
    const updatedThread: ThreadRecord = {
      ...thread,
      title,
      updatedAt: this.deps.timestamp()
    }

    this.deps.storage.renameThread({
      threadId: thread.id,
      title: updatedThread.title,
      updatedAt: updatedThread.updatedAt
    })

    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    return updatedThread
  }

  archiveThread(input: { threadId: string }): void {
    const thread = this.deps.requireThread(input.threadId)
    if (this.deps.isThreadRunning(thread.id)) {
      throw new Error('Cannot archive a thread with an active run.')
    }
    const timestamp = this.deps.timestamp()
    const archivedThread: ThreadRecord = {
      ...thread,
      archivedAt: timestamp,
      updatedAt: timestamp
    }

    this.deps.storage.archiveThread({
      threadId: thread.id,
      archivedAt: timestamp,
      updatedAt: timestamp
    })

    this.deps.emit<ThreadArchivedEvent>({
      type: 'thread.archived',
      threadId: thread.id,
      thread: archivedThread
    })
  }

  async saveThread(input: SaveThreadInput): Promise<SaveThreadResult> {
    const thread = this.deps.requireThread(input.threadId)
    if (this.deps.isThreadRunning(thread.id)) {
      throw new Error('Cannot save a thread while it still has an active run.')
    }
    if (!this.deps.memoryService.isConfigured()) {
      throw new Error('Memory is not enabled.')
    }

    const saved = await this.deps.memoryService.saveThread({
      thread,
      messages: this.deps.loadThreadMessages(thread.id)
    })

    if (!input.archiveAfterSave) {
      return {
        archived: false,
        savedMemoryCount: saved.savedCount,
        thread
      }
    }

    this.archiveThread({ threadId: thread.id })

    return {
      archived: true,
      savedMemoryCount: saved.savedCount,
      thread: this.requireArchivedThread(thread.id)
    }
  }

  restoreThread(input: { threadId: string }): ThreadRecord {
    const thread = this.requireArchivedThread(input.threadId)
    const timestamp = this.deps.timestamp()
    const restoredThread: ThreadRecord = {
      ...thread,
      updatedAt: timestamp
    }
    delete restoredThread.archivedAt

    this.deps.storage.restoreThread({
      threadId: thread.id,
      updatedAt: timestamp
    })

    this.deps.emit<ThreadRestoredEvent>({
      type: 'thread.restored',
      threadId: restoredThread.id,
      thread: restoredThread
    })

    return restoredThread
  }

  async deleteThread(input: { threadId: string }): Promise<void> {
    const activeThread = this.deps.storage.getThread(input.threadId)
    const archivedThread = this.deps.storage.getArchivedThread(input.threadId)
    const thread = activeThread ?? archivedThread

    if (!thread) {
      throw new Error(`Unknown thread: ${input.threadId}`)
    }

    if (this.deps.isThreadRunning(thread.id)) {
      throw new Error('Cannot delete a thread with an active run.')
    }

    if (!thread.workspacePath) {
      await this.deps.deleteThreadWorkspace(thread.id)
    }
    this.deps.storage.deleteThread({ threadId: thread.id })
    this.deps.emit<ThreadDeletedEvent>({
      type: 'thread.deleted',
      threadId: thread.id
    })
  }

  selectReplyBranch(input: { threadId: string; assistantMessageId: string }): ThreadRecord {
    const thread = this.deps.requireThread(input.threadId)
    if (this.deps.isThreadRunning(thread.id)) {
      throw new Error('Cannot switch reply branches while this thread is running.')
    }

    const { sourceAssistantMessage } = resolveRetryRequest(
      thread,
      this.loadThreadMessages(thread.id),
      input.assistantMessageId
    )
    if (!sourceAssistantMessage) {
      throw new Error('This message cannot be used as a reply branch.')
    }

    const messages = this.loadThreadMessages(thread.id)
    const nextHeadMessageId =
      pickLatestLeafId(messages, sourceAssistantMessage.id) ?? sourceAssistantMessage.id
    const previewSource = messages.find((message) => message.id === nextHeadMessageId)
    const preview = previewSource ? summarizeMessageInput(previewSource) : ''
    const timestamp = this.deps.timestamp()
    const updatedThread: ThreadRecord = {
      ...thread,
      updatedAt: timestamp,
      headMessageId: nextHeadMessageId,
      ...(preview ? { preview: preview.slice(0, 240) } : {})
    }

    if (!preview) {
      delete updatedThread.preview
    }

    this.deps.storage.updateThread(updatedThread)
    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    return updatedThread
  }

  async createBranch(input: { threadId: string; messageId: string }): Promise<ThreadSnapshot> {
    const thread = this.deps.requireThread(input.threadId)
    if (this.deps.isThreadRunning(thread.id)) {
      throw new Error('Cannot branch a thread with an active run.')
    }

    const messages = this.loadThreadMessages(thread.id)
    const branchPoint = messages.find((message) => message.id === input.messageId)

    if (!branchPoint) {
      throw new Error(`Unknown message: ${input.messageId}`)
    }

    const path = collectMessagePath(messages, branchPoint.id)
    const timestamp = this.deps.timestamp()
    const branchCreatedAtMs = Date.parse(timestamp)
    const threadId = this.deps.createId()
    const idMap = new Map<string, string>()
    const clonedMessages = path.map((message) => {
      const clonedId = this.deps.createId()
      idMap.set(message.id, clonedId)
      const createdAt =
        Number.isFinite(branchCreatedAtMs) && message.createdAt.localeCompare(timestamp) >= 0
          ? new Date(branchCreatedAtMs - (path.length - idMap.size + 1)).toISOString()
          : message.createdAt

      return {
        ...message,
        createdAt,
        id: clonedId,
        threadId,
        ...(message.parentMessageId ? { parentMessageId: idMap.get(message.parentMessageId)! } : {})
      }
    })
    const previewSource = clonedMessages.at(-1)
    const preview = previewSource ? summarizeMessageInput(previewSource) : ''
    const branchThread: ThreadRecord = {
      id: threadId,
      title: deriveBranchTitle(thread, branchPoint),
      updatedAt: timestamp,
      branchFromThreadId: thread.id,
      branchFromMessageId: branchPoint.id,
      ...(thread.workspacePath ? { workspacePath: thread.workspacePath } : {}),
      ...(preview ? { preview: preview.slice(0, 240) } : {}),
      ...(previewSource ? { headMessageId: previewSource.id } : {})
    }

    if (!thread.workspacePath) {
      await this.deps.cloneThreadWorkspace(thread.id, branchThread.id)
    }
    this.deps.storage.createThread({
      thread: branchThread,
      createdAt: timestamp,
      messages: clonedMessages
    })

    this.deps.emit<ThreadCreatedEvent>({
      type: 'thread.created',
      threadId: branchThread.id,
      thread: branchThread
    })
    this.deps.emit<ThreadStateReplacedEvent>({
      type: 'thread.state.replaced',
      threadId: branchThread.id,
      thread: branchThread,
      messages: clonedMessages,
      toolCalls: []
    })

    return {
      thread: branchThread,
      messages: clonedMessages,
      toolCalls: []
    }
  }

  deleteMessageFromHere(input: { threadId: string; messageId: string }): ThreadSnapshot {
    const thread = this.deps.requireThread(input.threadId)
    if (this.deps.isThreadRunning(thread.id)) {
      throw new Error('Cannot edit history while this thread is running.')
    }

    const messages = this.loadThreadMessages(thread.id)
    const targetMessage = messages.find((message) => message.id === input.messageId)

    if (!targetMessage) {
      throw new Error(`Unknown message: ${input.messageId}`)
    }

    const deletedIds = collectDescendantIds(messages, targetMessage.id)
    const remainingMessages = sortMessagesByCreatedAt(
      messages.filter((message) => !deletedIds.has(message.id))
    )
    const timestamp = this.deps.timestamp()
    const nextHeadMessageId = pickReplacementHeadId(
      messages,
      remainingMessages,
      thread.headMessageId
    )
    const previewSource = nextHeadMessageId
      ? remainingMessages.find((message) => message.id === nextHeadMessageId)
      : undefined
    const preview = previewSource ? summarizeMessageInput(previewSource) : ''
    const updatedThread: ThreadRecord = {
      ...thread,
      title: remainingMessages.length === 0 ? DEFAULT_THREAD_TITLE : thread.title,
      updatedAt: timestamp,
      ...(thread.queuedFollowUpMessageId && !deletedIds.has(thread.queuedFollowUpMessageId)
        ? {
            queuedFollowUpEnabledTools: thread.queuedFollowUpEnabledTools,
            queuedFollowUpMessageId: thread.queuedFollowUpMessageId
          }
        : {}),
      ...(nextHeadMessageId ? { headMessageId: nextHeadMessageId } : {}),
      ...(preview ? { preview: preview.slice(0, 240) } : {})
    }

    if (!nextHeadMessageId) {
      delete updatedThread.headMessageId
    }

    if (!preview) {
      delete updatedThread.preview
    }

    if (thread.queuedFollowUpMessageId && deletedIds.has(thread.queuedFollowUpMessageId)) {
      delete updatedThread.queuedFollowUpEnabledTools
      delete updatedThread.queuedFollowUpMessageId
    }

    this.deps.storage.deleteMessages({
      thread: updatedThread,
      messageIds: [...deletedIds]
    })

    const toolCalls = this.loadThreadToolCalls(updatedThread.id)
    this.deps.emit<ThreadStateReplacedEvent>({
      type: 'thread.state.replaced',
      threadId: updatedThread.id,
      thread: updatedThread,
      messages: remainingMessages,
      toolCalls
    })

    return {
      thread: updatedThread,
      messages: remainingMessages,
      toolCalls
    }
  }

  private loadThreadMessages(threadId: string): MessageRecord[] {
    return this.deps.storage.listThreadMessages(threadId)
  }

  private loadThreadToolCalls(threadId: string): ToolCallRecord[] {
    return this.deps.storage.listThreadToolCalls(threadId)
  }

  private requireArchivedThread(threadId: string): ThreadRecord {
    const thread = this.deps.storage.getArchivedThread(threadId)
    if (!thread) {
      throw new Error(`Unknown archived thread: ${threadId}`)
    }

    return thread
  }
}
