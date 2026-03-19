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
  ThreadStateReplacedEvent,
  ThreadUpdatedEvent,
  ToolCallRecord,
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
import { executeServerRun, type RestartRunReason, type ExecuteRunResult } from './runExecution.ts'
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
  pendingSteerMessageId?: string
  updateHeadOnComplete: boolean
}

interface PreparedQueuedFollowUpStart {
  createdAt: string
  enabledTools: ToolCallName[]
  requestMessageId: string
  runId: string
  thread: ThreadRecord
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
  loadThreadToolCalls: (threadId: string) => ToolCallRecord[]
}

function toRestartRunReason(nextRequestMessageId: string): RestartRunReason {
  return {
    type: 'restart',
    nextRequestMessageId
  }
}

function withParentMessageId(message: MessageRecord, parentMessageId?: string): MessageRecord {
  const rest = { ...message }
  delete rest.parentMessageId

  return {
    ...rest,
    ...(parentMessageId ? { parentMessageId } : {})
  }
}

export class YachiyoServerRunDomain {
  private readonly deps: RunDomainDeps
  private readonly activeRuns = new Map<string, RunState>()
  private readonly activeRunByThread = new Map<string, string>()
  private readonly activeRunTasks = new Map<string, Promise<void>>()
  private lastRunEnabledTools: ToolCallName[]
  private isClosing = false

  constructor(deps: RunDomainDeps) {
    this.deps = deps
    this.lastRunEnabledTools = resolveEnabledTools(this.deps.readConfig().enabledTools)
  }

  hasActiveThread(threadId: string): boolean {
    return this.activeRunByThread.has(threadId)
  }

  async close(): Promise<void> {
    this.isClosing = true

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

  prepareRecoveredQueuedFollowUps(): string[] {
    return this.deps.storage
      .bootstrap()
      .threads.filter((thread) => thread.queuedFollowUpMessageId)
      .map((thread) => thread.id)
  }

  scheduleRecoveredQueuedFollowUps(threadIds: string[]): void {
    if (threadIds.length === 0) {
      return
    }

    setTimeout(() => {
      for (const threadId of threadIds) {
        this.startQueuedFollowUpIfPresent(threadId)
      }
    }, 0)
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
    const activeRunId = this.activeRunByThread.get(thread.id)
    const mode = input.mode ?? 'normal'

    if (!activeRunId) {
      return this.startFreshRun({
        content,
        enabledTools,
        images,
        thread
      })
    }

    if (mode === 'steer') {
      return this.sendActiveRunSteer({
        activeRunId,
        content,
        images,
        thread
      })
    }

    if (mode === 'follow-up') {
      return this.queueFollowUp({
        content,
        enabledTools,
        images,
        thread
      })
    }

    throw new Error('This thread already has an active run.')
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

  private startFreshRun(input: {
    content: string
    enabledTools: ToolCallName[]
    images: MessageRecord['images']
    thread: ThreadRecord
  }): ChatAccepted {
    const timestamp = this.deps.timestamp()
    const messageSummary = summarizeMessageInput({
      content: input.content,
      images: input.images
    })
    const userMessage = this.createUserMessage({
      content: input.content,
      images: input.images,
      parentMessageId: input.thread.headMessageId,
      threadId: input.thread.id,
      timestamp
    })
    const updatedThread: ThreadRecord = {
      ...input.thread,
      headMessageId: userMessage.id,
      ...(messageSummary ? { preview: messageSummary.slice(0, 240) } : {}),
      title:
        input.thread.title === DEFAULT_THREAD_TITLE
          ? (messageSummary || DEFAULT_THREAD_TITLE).slice(0, 60)
          : input.thread.title,
      updatedAt: timestamp
    }
    const accepted: ChatAccepted = {
      kind: 'run-started',
      runId: this.deps.createId(),
      thread: updatedThread,
      userMessage
    }

    this.deps.storage.startRun({
      runId: accepted.runId,
      requestMessageId: userMessage.id,
      thread: input.thread,
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
      enabledTools: input.enabledTools,
      runId: accepted.runId,
      thread: accepted.thread,
      requestMessageId: userMessage.id,
      updateHeadOnComplete: true
    })

    return accepted
  }

  private sendActiveRunSteer(input: {
    activeRunId: string
    content: string
    images: MessageRecord['images']
    thread: ThreadRecord
  }): ChatAccepted {
    const activeRun = this.activeRuns.get(input.activeRunId)
    if (!activeRun) {
      throw new Error('This thread no longer has an active run.')
    }

    const timestamp = this.deps.timestamp()
    const userMessage = this.createUserMessage({
      content: input.content,
      images: input.images,
      parentMessageId: activeRun.pendingSteerMessageId ?? activeRun.requestMessageId,
      threadId: input.thread.id,
      timestamp
    })
    const updatedThread: ThreadRecord = {
      ...input.thread,
      headMessageId: userMessage.id,
      updatedAt: timestamp
    }

    this.deps.storage.saveThreadMessage({
      thread: input.thread,
      updatedThread,
      message: userMessage
    })
    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    activeRun.pendingSteerMessageId = userMessage.id
    activeRun.abortController.abort(toRestartRunReason(userMessage.id))

    return {
      kind: 'active-run-steer',
      runId: input.activeRunId,
      thread: updatedThread,
      userMessage
    }
  }

  private queueFollowUp(input: {
    content: string
    enabledTools: ToolCallName[]
    images: MessageRecord['images']
    thread: ThreadRecord
  }): ChatAccepted {
    const activeRunId = this.activeRunByThread.get(input.thread.id)
    const activeRun = activeRunId ? this.activeRuns.get(activeRunId) : null
    if (!activeRunId || !activeRun) {
      return this.startFreshRun(input)
    }

    const timestamp = this.deps.timestamp()
    const previousQueuedMessageId = input.thread.queuedFollowUpMessageId
    const userMessage = this.createUserMessage({
      content: input.content,
      images: input.images,
      parentMessageId: activeRun.pendingSteerMessageId ?? activeRun.requestMessageId,
      threadId: input.thread.id,
      timestamp
    })
    const updatedThread: ThreadRecord = {
      ...input.thread,
      queuedFollowUpEnabledTools: [...input.enabledTools],
      queuedFollowUpMessageId: userMessage.id,
      updatedAt: timestamp
    }

    this.deps.storage.saveThreadMessage({
      thread: input.thread,
      updatedThread,
      message: userMessage,
      ...(previousQueuedMessageId ? { replacedMessageId: previousQueuedMessageId } : {})
    })
    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    return {
      kind: 'active-run-follow-up',
      runId: activeRunId,
      thread: updatedThread,
      userMessage,
      ...(previousQueuedMessageId ? { replacedMessageId: previousQueuedMessageId } : {})
    }
  }

  private createUserMessage(input: {
    content: string
    images: MessageRecord['images']
    parentMessageId?: string
    threadId: string
    timestamp: string
  }): MessageRecord {
    return {
      id: this.deps.createId(),
      threadId: input.threadId,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
      role: 'user',
      content: input.content,
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      status: 'completed',
      createdAt: input.timestamp
    }
  }

  private startActiveRun(input: {
    enabledTools: ToolCallName[]
    runId: string
    thread: ThreadRecord
    requestMessageId: string
    updateHeadOnComplete: boolean
  }): void {
    this.activeRuns.set(input.runId, {
      threadId: input.thread.id,
      requestMessageId: input.requestMessageId,
      abortController: new AbortController(),
      updateHeadOnComplete: input.updateHeadOnComplete
    })
    this.activeRunByThread.set(input.thread.id, input.runId)

    const runTask = this.runLoop({
      enabledTools: input.enabledTools,
      runId: input.runId,
      thread: input.thread,
      requestMessageId: input.requestMessageId,
      updateHeadOnComplete: input.updateHeadOnComplete
    })
    this.activeRunTasks.set(input.runId, runTask)
    void runTask
  }

  private async runLoop(input: {
    enabledTools: ToolCallName[]
    runId: string
    thread: ThreadRecord
    requestMessageId: string
    updateHeadOnComplete: boolean
  }): Promise<void> {
    let currentThread = input.thread
    let currentRequestMessageId = input.requestMessageId
    let previousEnabledTools = this.lastRunEnabledTools
    let result: ExecuteRunResult = { kind: 'cancelled' }

    try {
      while (true) {
        const activeRun = this.activeRuns.get(input.runId)
        if (!activeRun) {
          return
        }

        const abortController = new AbortController()
        activeRun.abortController = abortController
        activeRun.requestMessageId = currentRequestMessageId

        result = await executeServerRun(
          {
            storage: this.deps.storage,
            createId: this.deps.createId,
            timestamp: this.deps.timestamp,
            emit: this.deps.emit,
            createModelRuntime: this.deps.createModelRuntime,
            ensureThreadWorkspace: this.deps.ensureThreadWorkspace,
            readThread: this.deps.requireThread,
            readSettings: this.deps.readSettings,
            loadThreadMessages: this.deps.loadThreadMessages,
            onEnabledToolsUsed: (enabledTools) => {
              this.lastRunEnabledTools = [...enabledTools]
            },
            onTerminalState: () => {
              this.activeRuns.delete(input.runId)
              this.activeRunByThread.delete(input.thread.id)
              this.activeRunTasks.delete(input.runId)
            }
          },
          {
            abortController,
            enabledTools: input.enabledTools,
            previousEnabledTools,
            requestMessageId: currentRequestMessageId,
            runId: input.runId,
            thread: currentThread,
            updateHeadOnComplete: input.updateHeadOnComplete
          }
        )

        previousEnabledTools = input.enabledTools

        if (result.kind !== 'restarted') {
          break
        }

        const nextRequestMessageId = activeRun.pendingSteerMessageId ?? result.nextRequestMessageId

        activeRun.pendingSteerMessageId = undefined
        activeRun.requestMessageId = nextRequestMessageId
        currentRequestMessageId = nextRequestMessageId
        currentThread = this.deps.requireThread(input.thread.id)
        this.emitThreadStateReplaced(currentThread.id)
      }
    } finally {
      this.activeRuns.delete(input.runId)
      this.activeRunByThread.delete(input.thread.id)
      this.activeRunTasks.delete(input.runId)

      if (!this.isClosing && result.kind !== 'restarted') {
        this.startQueuedFollowUpIfPresent(input.thread.id)
      }
    }
  }

  private startQueuedFollowUpIfPresent(threadId: string): void {
    const prepared = this.prepareQueuedFollowUpStart(threadId)
    if (!prepared) {
      return
    }

    this.activatePreparedQueuedFollowUp(prepared, {
      emitThreadStateReplaced: true
    })
  }

  private prepareQueuedFollowUpStart(threadId: string): PreparedQueuedFollowUpStart | null {
    if (this.activeRunByThread.has(threadId)) {
      return null
    }

    const thread = this.deps.requireThread(threadId)
    const queuedMessageId = thread.queuedFollowUpMessageId
    if (!queuedMessageId) {
      if (thread.queuedFollowUpEnabledTools) {
        const clearedThread: ThreadRecord = {
          ...thread,
          updatedAt: this.deps.timestamp()
        }
        delete clearedThread.queuedFollowUpEnabledTools
        this.deps.storage.updateThread(clearedThread)
      }
      return null
    }

    const queuedMessage = this.deps
      .loadThreadMessages(threadId)
      .find((message) => message.id === queuedMessageId && message.role === 'user')
    if (!queuedMessage) {
      const clearedThread: ThreadRecord = {
        ...thread,
        updatedAt: this.deps.timestamp()
      }
      delete clearedThread.queuedFollowUpEnabledTools
      delete clearedThread.queuedFollowUpMessageId

      this.deps.storage.updateThread(clearedThread)
      return null
    }

    const reparentedQueuedMessage = withParentMessageId(queuedMessage, thread.headMessageId)
    if (reparentedQueuedMessage.parentMessageId !== queuedMessage.parentMessageId) {
      this.deps.storage.updateMessage(reparentedQueuedMessage)
    }

    const timestamp = this.deps.timestamp()
    const messageSummary = summarizeMessageInput(reparentedQueuedMessage)
    const updatedThread: ThreadRecord = {
      ...thread,
      headMessageId: queuedMessage.id,
      ...(messageSummary ? { preview: messageSummary.slice(0, 240) } : {}),
      updatedAt: timestamp
    }
    delete updatedThread.queuedFollowUpEnabledTools
    delete updatedThread.queuedFollowUpMessageId

    this.deps.storage.updateThread(updatedThread)

    const enabledTools = thread.queuedFollowUpEnabledTools
      ? [...thread.queuedFollowUpEnabledTools]
      : resolveEnabledTools(undefined, this.deps.readConfig().enabledTools)
    const runId = this.deps.createId()

    return {
      createdAt: timestamp,
      enabledTools,
      requestMessageId: queuedMessage.id,
      runId,
      thread: updatedThread
    }
  }

  private activatePreparedQueuedFollowUp(
    prepared: PreparedQueuedFollowUpStart,
    options: { emitThreadStateReplaced?: boolean } = {}
  ): void {
    if (this.isClosing || this.activeRunByThread.has(prepared.thread.id)) {
      return
    }

    const currentThread = this.deps.requireThread(prepared.thread.id)
    this.deps.storage.startRun({
      runId: prepared.runId,
      requestMessageId: prepared.requestMessageId,
      thread: currentThread,
      updatedThread: prepared.thread,
      createdAt: prepared.createdAt
    })

    if (options.emitThreadStateReplaced) {
      this.emitThreadStateReplaced(prepared.thread.id)
    }

    this.deps.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: prepared.thread.id,
      runId: prepared.runId,
      requestMessageId: prepared.requestMessageId
    })

    this.startActiveRun({
      enabledTools: prepared.enabledTools,
      runId: prepared.runId,
      thread: prepared.thread,
      requestMessageId: prepared.requestMessageId,
      updateHeadOnComplete: true
    })
  }

  private emitThreadStateReplaced(threadId: string): void {
    const thread = this.deps.requireThread(threadId)
    const messages = this.deps.loadThreadMessages(threadId)
    const toolCalls = this.deps.loadThreadToolCalls(threadId)

    this.deps.emit<ThreadStateReplacedEvent>({
      type: 'thread.state.replaced',
      threadId,
      thread,
      messages,
      toolCalls
    })
  }
}
