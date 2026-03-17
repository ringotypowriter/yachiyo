import type {
  ChatAccepted,
  MessageRecord,
  ProviderSettings,
  RetryAccepted,
  RetryInput,
  RunCreatedEvent,
  SendChatInput,
  SettingsConfig,
  ThreadRecord,
  ThreadUpdatedEvent,
  ToolCallName
} from '../../../../shared/yachiyo/protocol.ts'
import {
  hasMessagePayload,
  normalizeMessageImages,
  summarizeMessageInput
} from '../../../../shared/yachiyo/messageContent.ts'
import type { ModelRuntime } from '../../runtime/types.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import { assertSupportedImages, resolveEnabledTools } from './configDomain.ts'
import { executeServerRun } from './runExecution.ts'
import { resolveRetryRequest } from './threadDomain.ts'
import {
  DEFAULT_THREAD_TITLE,
  INTERRUPTED_RUN_ERROR,
  SHUTDOWN_RUN_ERROR,
  type CreateId,
  type EmitServerEvent,
  type Timestamp
} from './shared.ts'

interface RunState {
  threadId: string
  requestMessageId: string
  abortController: AbortController
  updateHeadOnComplete: boolean
}

interface RunDomainDeps {
  storage: YachiyoStorage
  createId: CreateId
  timestamp: Timestamp
  emit: EmitServerEvent
  createModelRuntime: () => ModelRuntime
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  readConfig: () => SettingsConfig
  readSettings: () => ProviderSettings
  requireThread: (threadId: string) => ThreadRecord
  loadThreadMessages: (threadId: string) => MessageRecord[]
}

export class YachiyoServerRunDomain {
  private readonly deps: RunDomainDeps
  private readonly activeRuns = new Map<string, RunState>()
  private readonly activeRunByThread = new Map<string, string>()
  private readonly activeRunTasks = new Map<string, Promise<void>>()
  private lastRunEnabledTools: ToolCallName[]

  constructor(deps: RunDomainDeps) {
    this.deps = deps
    this.lastRunEnabledTools = resolveEnabledTools(this.deps.readConfig().enabledTools)
  }

  hasActiveThread(threadId: string): boolean {
    return this.activeRunByThread.has(threadId)
  }

  async close(): Promise<void> {
    for (const state of this.activeRuns.values()) {
      state.abortController.abort()
    }

    if (this.activeRunTasks.size > 0) {
      await Promise.allSettled(this.activeRunTasks.values())
    }

    this.recoverInterruptedRuns(SHUTDOWN_RUN_ERROR)
    this.activeRuns.clear()
    this.activeRunByThread.clear()
    this.activeRunTasks.clear()
  }

  recoverInterruptedRuns(error: string = INTERRUPTED_RUN_ERROR): void {
    this.deps.storage.recoverInterruptedRuns({
      error,
      finishedAt: this.deps.timestamp()
    })
  }

  async sendChat(input: SendChatInput): Promise<ChatAccepted> {
    const content = input.content.trim()
    const images = normalizeMessageImages(input.images)
    const enabledTools = resolveEnabledTools(
      input.enabledTools,
      this.deps.readConfig().enabledTools
    )

    if (!hasMessagePayload({ content, images })) {
      throw new Error('Cannot send an empty message.')
    }
    assertSupportedImages(images)

    const thread = this.deps.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('This thread already has an active run.')
    }

    const timestamp = this.deps.timestamp()
    const messageSummary = summarizeMessageInput({ content, images })
    const userMessage: MessageRecord = {
      id: this.deps.createId(),
      threadId: thread.id,
      ...(thread.headMessageId ? { parentMessageId: thread.headMessageId } : {}),
      role: 'user',
      content,
      ...(images.length > 0 ? { images } : {}),
      status: 'completed',
      createdAt: timestamp
    }
    const updatedThread: ThreadRecord = {
      ...thread,
      headMessageId: userMessage.id,
      ...(messageSummary ? { preview: messageSummary.slice(0, 240) } : {}),
      title:
        thread.title === DEFAULT_THREAD_TITLE
          ? (messageSummary || DEFAULT_THREAD_TITLE).slice(0, 60)
          : thread.title,
      updatedAt: timestamp
    }
    const accepted = {
      runId: this.deps.createId(),
      thread: updatedThread,
      userMessage
    }

    this.deps.storage.startRun({
      runId: accepted.runId,
      requestMessageId: userMessage.id,
      thread,
      updatedThread,
      userMessage,
      createdAt: timestamp
    })

    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: accepted.thread.id,
      thread: accepted.thread
    })
    this.deps.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: accepted.thread.id,
      runId: accepted.runId,
      requestMessageId: userMessage.id
    })

    this.startActiveRun({
      enabledTools,
      runId: accepted.runId,
      thread: accepted.thread,
      requestMessageId: userMessage.id,
      updateHeadOnComplete: true
    })

    return accepted
  }

  async retryMessage(input: RetryInput): Promise<RetryAccepted> {
    const thread = this.deps.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('This thread already has an active run.')
    }

    const enabledTools = resolveEnabledTools(
      input.enabledTools,
      this.deps.readConfig().enabledTools
    )
    const messages = this.deps.loadThreadMessages(thread.id)
    const { requestMessage, sourceAssistantMessage } = resolveRetryRequest(
      thread,
      messages,
      input.messageId
    )
    const timestamp = this.deps.timestamp()
    const updatedThread: ThreadRecord = {
      ...thread,
      updatedAt: timestamp
    }
    const accepted: RetryAccepted = {
      runId: this.deps.createId(),
      thread: updatedThread,
      requestMessageId: requestMessage.id,
      ...(sourceAssistantMessage ? { sourceAssistantMessageId: sourceAssistantMessage.id } : {})
    }

    this.deps.storage.startRun({
      runId: accepted.runId,
      requestMessageId: requestMessage.id,
      thread,
      updatedThread,
      createdAt: timestamp
    })

    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: accepted.thread.id,
      thread: accepted.thread
    })
    this.deps.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: accepted.thread.id,
      runId: accepted.runId,
      requestMessageId: requestMessage.id
    })

    this.startActiveRun({
      enabledTools,
      runId: accepted.runId,
      thread: accepted.thread,
      requestMessageId: requestMessage.id,
      updateHeadOnComplete: true
    })

    return accepted
  }

  cancelRun(input: { runId: string }): void {
    this.activeRuns.get(input.runId)?.abortController.abort()
  }

  private startActiveRun(input: {
    enabledTools: ToolCallName[]
    runId: string
    thread: ThreadRecord
    requestMessageId: string
    updateHeadOnComplete: boolean
  }): void {
    const abortController = new AbortController()
    this.activeRuns.set(input.runId, {
      threadId: input.thread.id,
      requestMessageId: input.requestMessageId,
      abortController,
      updateHeadOnComplete: input.updateHeadOnComplete
    })
    this.activeRunByThread.set(input.thread.id, input.runId)
    const runTask = this.executeRun({
      abortController,
      enabledTools: input.enabledTools,
      requestMessageId: input.requestMessageId,
      runId: input.runId,
      thread: input.thread,
      updateHeadOnComplete: input.updateHeadOnComplete
    })
    this.activeRunTasks.set(input.runId, runTask)
    void runTask
  }

  private executeRun(input: {
    enabledTools: ToolCallName[]
    runId: string
    thread: ThreadRecord
    requestMessageId: string
    abortController: AbortController
    updateHeadOnComplete: boolean
  }): Promise<void> {
    return executeServerRun(
      {
        storage: this.deps.storage,
        createId: this.deps.createId,
        timestamp: this.deps.timestamp,
        emit: this.deps.emit,
        createModelRuntime: this.deps.createModelRuntime,
        ensureThreadWorkspace: this.deps.ensureThreadWorkspace,
        readSettings: this.deps.readSettings,
        loadThreadMessages: this.deps.loadThreadMessages,
        onEnabledToolsUsed: (enabledTools) => {
          this.lastRunEnabledTools = [...enabledTools]
        },
        onSettled: () => {
          this.activeRuns.delete(input.runId)
          this.activeRunByThread.delete(input.thread.id)
          this.activeRunTasks.delete(input.runId)
        }
      },
      {
        ...input,
        previousEnabledTools: this.lastRunEnabledTools
      }
    )
  }
}
