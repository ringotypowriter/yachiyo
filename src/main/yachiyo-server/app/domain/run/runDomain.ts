import type {
  BackgroundTaskLogAppendEvent,
  BackgroundTaskSnapshot,
  ChatAccepted,
  ComposerReasoningSelection,
  CompactThreadAccepted,
  HarnessFinishedEvent,
  MessageCompletedEvent,
  MessageRecord,
  RunCancelledEvent,
  RunCompletedEvent,
  RetryAccepted,
  RetryInput,
  RunFailedEvent,
  RunCreatedEvent,
  SendChatInput,
  ThreadRecord,
  ThreadStateReplacedEvent,
  ThreadUpdatedEvent,
  ToolCallUpdatedEvent,
  ToolCallRecord,
  ToolCallName
} from '../../../../../shared/yachiyo/protocol.ts'
import { summarizeMessageInput } from '../../../../../shared/yachiyo/messageContent.ts'
import {
  getThreadCapabilities,
  normalizeSkillNames
} from '../../../../../shared/yachiyo/protocol.ts'
import {
  createMemoryDistillationScheduler,
  type MemoryDistillationScheduler
} from '../../../services/memory/memoryDistillationScheduler.ts'
import type { RunRecoveryCheckpoint } from '../../../storage/storage.ts'
import { wouldCreateParentCycle } from '../../../../../shared/yachiyo/threadTree.ts'
import { BackgroundBashManager } from '../backgroundBashManager.ts'
import { resolveEnabledTools } from '../configDomain.ts'
import { executeServerRun } from './execution/executeServerRun.ts'
import type { ExecuteRunInput, ExecuteRunResult } from './execution/runExecutionTypes.ts'
import { ReadRecordCache } from '../../../tools/agentTools.ts'
import { SnapshotTracker } from '../../../services/fileSnapshot/snapshotTracker.ts'
import { runAcpChatThread } from '../../../runtime/acp/acpChatRuntime.ts'
import { resolveRetryRequest } from '../threadDomain.ts'
import { sleep } from '../../../channels/connectionRetry.ts'
import {
  DEFAULT_HARNESS_NAME,
  INTERRUPTED_RUN_ERROR,
  SHUTDOWN_RUN_ERROR,
  isAbortError
} from '../shared.ts'
import {
  type BackgroundTaskRunContext,
  type PreparedQueuedFollowUpStart,
  type RunDomainDeps,
  type RunState
} from './runTypes.ts'
import { createEphemeralStorageProxy, type EphemeralStorage } from './chat/ephemeralStorage.ts'
import { type DebouncedSendChatEntry } from './chat/sendChatDebounce.ts'
import { persistSteerMessage, sendChatFlow, type SendChatFlowContext } from './chat/sendChatFlow.ts'
import { resolveEffectiveThreadMessages, withParentMessageId } from './chat/threadMessages.ts'
import {
  startActiveRun,
  startAssistantOnlyRun,
  startRecoveredRun,
  type ActiveRunLoopInput,
  type ActiveRunStartContext
} from './active/activeRunStart.ts'
import {
  answerToolQuestion,
  cancelRun,
  cancelRunForChannelUser,
  cancelRunForThread,
  withdrawPendingSteer,
  type ActiveRunControlContext
} from './active/activeRunControl.ts'
import { mergeUsageForTerminal, usageFieldsFrom } from './loop/runUsage.ts'
import { buildRunExecutionDeps, type RunExecutionDepsContext } from './loop/runExecutionDeps.ts'
import {
  handleBackgroundBashCompleted,
  recoverOrphanedBackgroundToolCalls,
  type BackgroundTaskLifecycleContext
} from './background/backgroundTaskLifecycle.ts'
import { ThreadTitleGenerationRunner } from './title/threadTitleGeneration.ts'

export class YachiyoServerRunDomain {
  private readonly deps: RunDomainDeps
  private readonly activeRuns = new Map<string, RunState>()
  private readonly activeRunByThread = new Map<string, string>()
  private readonly activeRunTasks = new Map<string, Promise<void>>()
  private readonly debouncedSendChats = new Map<string, DebouncedSendChatEntry>()
  private readonly backgroundBashManager = new BackgroundBashManager()
  private readonly threadTitleRunner: ThreadTitleGenerationRunner
  /**
   * Per-task snapshot of the launching run's channel/tooling context, captured at
   * `onBackgroundBashStarted`. We use it to call `sendChat` with the same `enabledTools`,
   * `enabledSkillNames`, `channelHint`, and `extraTools` (e.g. an owner-DM `replyTool`)
   * when the background task finishes, so the auto-delivered "background task completed"
   * user message can drive a model run that matches the original transport contract.
   */
  private readonly backgroundTaskRunContext = new Map<string, BackgroundTaskRunContext>()
  private readonly memoryScheduler: MemoryDistillationScheduler
  private readonly readRecordCaches = new Map<string, ReadRecordCache>()
  private lastRunEnabledTools: ToolCallName[] | null
  private isClosing = false

  constructor(deps: RunDomainDeps) {
    this.deps = deps
    this.lastRunEnabledTools = null
    this.threadTitleRunner = new ThreadTitleGenerationRunner(deps)
    this.memoryScheduler = createMemoryDistillationScheduler({
      memoryService: deps.memoryService,
      readConfig: deps.readConfig,
      loadThreadMessages: deps.loadThreadMessages,
      getThread: (threadId) => deps.storage.getThread(threadId),
      getThreadTotalTokens: (threadId) => deps.storage.getThreadTotalTokens(threadId)
    })

    this.backgroundBashManager.setCompletionHandler((result) => {
      handleBackgroundBashCompleted(this.createBackgroundTaskLifecycleContext(), result)
    })
    this.backgroundBashManager.setLogAppendHandler((append) => {
      if (this.isClosing) return
      try {
        this.deps.emit<BackgroundTaskLogAppendEvent>({
          type: 'background-task.log-append',
          threadId: append.threadId,
          taskId: append.taskId,
          lines: append.lines
        })
      } catch (error) {
        console.warn('[yachiyo][background-bash] log-append emit failed', {
          taskId: append.taskId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
  }

  listBackgroundTasks(threadId?: string): BackgroundTaskSnapshot[] {
    return this.backgroundBashManager.listSnapshots(threadId)
  }

  getBackgroundTaskLogTarget(input: {
    threadId: string
    taskId: string
  }): ReturnType<BackgroundBashManager['getLogTarget']> {
    return this.backgroundBashManager.getLogTarget(input.threadId, input.taskId)
  }

  cancelBackgroundTask(taskId: string): boolean {
    return this.backgroundBashManager.cancelTask(taskId)
  }

  hasActiveThread(threadId: string): boolean {
    return this.hasNonRecapActiveRun(threadId)
  }

  private hasNonRecapActiveRun(threadId: string): boolean {
    const runId = this.activeRunByThread.get(threadId)
    if (!runId) return false
    const run = this.activeRuns.get(runId)
    return run != null && !run.recap
  }

  async close(): Promise<void> {
    this.isClosing = true

    for (const state of this.activeRuns.values()) {
      state.abortController.abort()
    }
    this.threadTitleRunner.abort()

    await this.backgroundBashManager.close()

    if (this.activeRunTasks.size > 0) {
      await Promise.allSettled(this.activeRunTasks.values())
    }
    await this.threadTitleRunner.close()
    await this.memoryScheduler.close()

    this.recoverInterruptedRuns(SHUTDOWN_RUN_ERROR)
    this.activeRuns.clear()
    this.activeRunByThread.clear()
    this.activeRunTasks.clear()
    this.debouncedSendChats.clear()
    this.backgroundTaskRunContext.clear()
    this.readRecordCaches.clear()
  }

  clearReadRecordCache(threadId: string): void {
    this.readRecordCaches.delete(threadId)
  }

  private createSendChatFlowContext(): SendChatFlowContext {
    return {
      deps: this.deps,
      activeRuns: this.activeRuns,
      activeRunByThread: this.activeRunByThread,
      debouncedSendChats: this.debouncedSendChats,
      threadTitleRunner: this.threadTitleRunner,
      startActiveRun: (input) => {
        startActiveRun(this.createActiveRunStartContext(), input)
      }
    }
  }

  private createActiveRunStartContext(): ActiveRunStartContext {
    return {
      deps: this.deps,
      activeRuns: this.activeRuns,
      activeRunByThread: this.activeRunByThread,
      activeRunTasks: this.activeRunTasks,
      isClosing: () => this.isClosing,
      runLoop: (input) => this.runLoop(input),
      threadTitleRunner: this.threadTitleRunner
    }
  }

  private createActiveRunControlContext(): ActiveRunControlContext {
    return {
      deps: this.deps,
      activeRuns: this.activeRuns,
      activeRunByThread: this.activeRunByThread
    }
  }

  private createRunExecutionDepsContext(): RunExecutionDepsContext {
    return {
      deps: this.deps,
      activeRuns: this.activeRuns,
      activeRunByThread: this.activeRunByThread,
      activeRunTasks: this.activeRunTasks,
      backgroundTaskRunContext: this.backgroundTaskRunContext,
      backgroundBashManager: this.backgroundBashManager,
      createSendChatFlowContext: () => this.createSendChatFlowContext(),
      setLastRunEnabledTools: (enabledTools) => {
        this.lastRunEnabledTools = [...enabledTools]
      }
    }
  }

  private createBackgroundTaskLifecycleContext(): BackgroundTaskLifecycleContext {
    return {
      deps: this.deps,
      backgroundTaskRunContext: this.backgroundTaskRunContext,
      isClosing: () => this.isClosing,
      sendChat: (input) => this.sendChat(input)
    }
  }

  private bindTerminalToolCallsToAssistant(input: {
    threadId: string
    runId: string
    assistantMessageId: string
  }): void {
    const toolCalls = this.deps
      .loadThreadToolCalls(input.threadId)
      .filter(
        (toolCall) =>
          toolCall.runId === input.runId &&
          toolCall.status !== 'preparing' &&
          toolCall.status !== 'running' &&
          toolCall.assistantMessageId !== input.assistantMessageId
      )

    for (const toolCall of toolCalls) {
      const updatedToolCall: ToolCallRecord = {
        ...toolCall,
        assistantMessageId: input.assistantMessageId
      }
      this.deps.storage.updateToolCall(updatedToolCall)
      this.deps.emit<ToolCallUpdatedEvent>({
        type: 'tool.updated',
        threadId: input.threadId,
        runId: input.runId,
        toolCall: updatedToolCall
      })
    }
  }

  private emitCancelledHarnessFinished(input: {
    threadId: string
    runId: string
    harnessId?: string
  }): void {
    if (!input.harnessId) {
      return
    }

    this.deps.emit<HarnessFinishedEvent>({
      type: 'harness.finished',
      threadId: input.threadId,
      runId: input.runId,
      harnessId: input.harnessId,
      name: DEFAULT_HARNESS_NAME,
      status: 'cancelled'
    })
  }

  recoverInterruptedRuns(error: string = INTERRUPTED_RUN_ERROR): void {
    this.deps.storage.recoverInterruptedRuns({
      error,
      finishedAt: this.deps.timestamp()
    })
    recoverOrphanedBackgroundToolCalls(this.createBackgroundTaskLifecycleContext())
  }

  prepareRecoveredQueuedFollowUps(): string[] {
    return this.deps.storage
      .bootstrap()
      .threads.filter((thread) => thread.queuedFollowUpMessageId)
      .map((thread) => thread.id)
  }

  prepareRecoveredRuns(): RunRecoveryCheckpoint[] {
    return this.deps.storage.listRunRecoveryCheckpoints().filter((checkpoint) => {
      if (this.activeRunByThread.has(checkpoint.threadId)) {
        return false
      }
      const run = this.deps.storage.getRun(checkpoint.runId)
      if (!run || run.status !== 'running') {
        this.deps.storage.deleteRunRecoveryCheckpoint(checkpoint.runId)
        return false
      }
      return true
    })
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

  scheduleRecoveredRuns(checkpoints: RunRecoveryCheckpoint[]): void {
    if (checkpoints.length === 0) {
      return
    }

    setTimeout(() => {
      for (const checkpoint of checkpoints) {
        startRecoveredRun(this.createActiveRunStartContext(), checkpoint)
      }
    }, 0)
  }

  async sendChat(input: SendChatInput): Promise<ChatAccepted> {
    return sendChatFlow(this.createSendChatFlowContext(), input)
  }

  async retryMessage(input: RetryInput): Promise<RetryAccepted> {
    const thread = this.deps.requireThread(input.threadId)
    if (!getThreadCapabilities(thread).canRetry) {
      throw new Error('ACP threads do not support retry.')
    }
    if (this.hasNonRecapActiveRun(thread.id)) {
      throw new Error('This thread already has an active run.')
    }

    const enabledTools = resolveEnabledTools(
      input.enabledTools,
      this.deps.readConfig().enabledTools
    )
    const enabledSkillNames =
      input.enabledSkillNames === undefined
        ? undefined
        : normalizeSkillNames(input.enabledSkillNames)
    const messages = this.deps.loadThreadMessages(thread.id)
    const { requestMessage, sourceAssistantMessage } = resolveRetryRequest(
      thread,
      messages,
      input.messageId
    )
    const timestamp = this.deps.timestamp()
    const updatedThread: ThreadRecord = {
      ...thread,
      headMessageId: requestMessage.id,
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

    startActiveRun(this.createActiveRunStartContext(), {
      enabledTools,
      enabledSkillNames,
      reasoningEffort: input.reasoningEffort,
      runId: accepted.runId,
      thread: accepted.thread,
      requestMessageId: requestMessage.id,
      updateHeadOnComplete: true
    })

    return accepted
  }

  async compactThreadToAnotherThread(input: {
    sourceThread: ThreadRecord
    destinationThread: ThreadRecord
    reasoningEffort?: ComposerReasoningSelection
  }): Promise<CompactThreadAccepted> {
    if (this.hasNonRecapActiveRun(input.sourceThread.id)) {
      throw new Error('Cannot compact a thread with an active run.')
    }

    const runId = this.deps.createId()
    const timestamp = this.deps.timestamp()
    const sourceMessages = this.deps.loadThreadMessages(input.sourceThread.id)
    const effectiveMessages = resolveEffectiveThreadMessages(input.sourceThread, sourceMessages)

    this.deps.storage.startRun({
      runId,
      thread: input.destinationThread,
      updatedThread: input.destinationThread,
      createdAt: timestamp
    })

    this.deps.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: input.destinationThread.id,
      runId
    })

    startAssistantOnlyRun(this.createActiveRunStartContext(), {
      runId,
      thread: input.destinationThread,
      sourceThreadId: input.sourceThread.id,
      sourceMessages: effectiveMessages,
      reasoningEffort: input.reasoningEffort
    })

    return {
      runId,
      sourceThreadId: input.sourceThread.id,
      thread: input.destinationThread
    }
  }

  async requestRecap(input: { threadId: string }): Promise<string | null> {
    try {
      const thread = this.deps.requireThread(input.threadId)
      if (this.activeRunByThread.has(input.threadId)) return null

      const messages = this.deps.loadThreadMessages(input.threadId)
      const lastPromptTokens =
        this.deps.storage.listThreadRuns(input.threadId)[0]?.promptTokens ?? 0
      if (messages.length <= 5 && lastPromptTokens <= 32_000) return null

      const runId = this.deps.createId()
      const messageId = this.deps.createId()
      const timestamp = this.deps.timestamp()

      const recapUserMessage: MessageRecord = {
        id: messageId,
        threadId: thread.id,
        parentMessageId: thread.headMessageId,
        role: 'user',
        content:
          'Quick recap — no deep thinking needed. The user stepped away and is coming back. Summarize in under 40 words, 1-2 plain sentences, no markdown. Match the language used in the conversation. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.',
        hidden: true,
        status: 'completed',
        createdAt: timestamp
      }

      const enabledTools = resolveEnabledTools(undefined, this.deps.readConfig().enabledTools)

      return new Promise<string | null>((resolve) => {
        startActiveRun(this.createActiveRunStartContext(), {
          enabledTools,
          runId,
          thread,
          requestMessageId: messageId,
          updateHeadOnComplete: false,
          recap: true
        })

        const activeRun = this.activeRuns.get(runId)
        if (activeRun) {
          activeRun.recapResolve = resolve
          activeRun.recapUserMessage = recapUserMessage
        } else {
          resolve(null)
        }
      })
    } catch {
      return null
    }
  }

  cancelRun(input: { runId: string }): void {
    cancelRun(this.createActiveRunControlContext(), input)
  }

  /** Cancel the active run for a thread, if any. Returns true if a run was cancelled. */
  cancelRunForThread(threadId: string): boolean {
    return cancelRunForThread(this.createActiveRunControlContext(), threadId)
  }

  /** Discard the pending steer for a thread without cancelling the run. */
  withdrawPendingSteer(threadId: string): void {
    withdrawPendingSteer(this.createActiveRunControlContext(), threadId)
  }

  /** Cancel any active run owned by the given channel user. Returns true if a run was cancelled. */
  cancelRunForChannelUser(channelUserId: string): boolean {
    return cancelRunForChannelUser(this.createActiveRunControlContext(), channelUserId)
  }

  answerToolQuestion(input: { runId: string; toolCallId: string; answer: string }): void {
    answerToolQuestion(this.createActiveRunControlContext(), input)
  }

  private async runLoop(input: ActiveRunLoopInput): Promise<void> {
    let currentThread = input.thread
    let currentRequestMessageId = input.requestMessageId
    let previousEnabledTools = this.lastRunEnabledTools
    let result: ExecuteRunResult = { kind: 'cancelled' }
    let accumulatedUsage: ExecuteRunInput['priorUsage'] | undefined
    let carriedSnapshotTracker: SnapshotTracker | undefined
    let carriedToolFailLoopSteers = 0
    let isSteerLeg = false

    try {
      while (true) {
        const activeRun = this.activeRuns.get(input.runId)
        if (!activeRun) {
          return
        }

        const abortController = new AbortController()
        activeRun.abortController = abortController
        activeRun.requestMessageId = currentRequestMessageId

        if (currentThread.runtimeBinding?.kind === 'acp') {
          result = await runAcpChatThread(
            {
              storage: this.deps.storage,
              createId: this.deps.createId,
              timestamp: this.deps.timestamp,
              emit: this.deps.emit,
              readThread: this.deps.requireThread,
              readConfig: this.deps.readConfig,
              loadThreadMessages: this.deps.loadThreadMessages,
              ensureThreadWorkspace: this.deps.ensureThreadWorkspace,
              onTerminalState: () => {
                this.activeRuns.delete(input.runId)
                this.activeRunByThread.delete(input.thread.id)
                this.activeRunTasks.delete(input.runId)
              }
            },
            {
              runId: input.runId,
              thread: currentThread,
              requestMessageId: currentRequestMessageId,
              abortController,
              updateHeadOnComplete: input.updateHeadOnComplete
            }
          )
          break
        }

        // Clear the carried reference so executeServerRun owns the tracker
        // exclusively — the finally block won't double-dispose a live tracker.
        const passTracker = carriedSnapshotTracker
        carriedSnapshotTracker = undefined
        const threadId = currentThread.id
        if (!this.readRecordCaches.has(threadId)) {
          this.readRecordCaches.set(threadId, new ReadRecordCache())
        }
        const readRecordCache = this.readRecordCaches.get(threadId)!

        const isRecapRun = activeRun?.recap === true
        const recapStorage = isRecapRun
          ? createEphemeralStorageProxy(this.deps.storage)
          : this.deps.storage
        const recapEmit: typeof this.deps.emit = isRecapRun ? () => {} : this.deps.emit

        result = await executeServerRun(
          buildRunExecutionDeps(this.createRunExecutionDepsContext(), {
            loopInput: input,
            currentThread,
            activeRun,
            isRecapRun,
            storage: recapStorage,
            emit: recapEmit
          }),
          {
            abortController,
            enabledTools: input.enabledTools,
            enabledSkillNames: activeRun.enabledSkillNames ?? input.enabledSkillNames,
            reasoningEffort: activeRun.reasoningEffort ?? input.reasoningEffort,
            inactivityTimeoutMs: this.deps.runInactivityTimeoutMs,
            channelHint: activeRun.channelHint ?? input.channelHint,
            extraTools: input.extraTools,
            previousEnabledTools,
            recoveryCheckpoint: activeRun.recoveryCheckpoint ?? input.recoveryCheckpoint,
            requestMessageId: currentRequestMessageId,
            runId: input.runId,
            thread: currentThread,
            updateHeadOnComplete: input.updateHeadOnComplete,
            ...(accumulatedUsage ? { priorUsage: accumulatedUsage } : {}),
            ...(isSteerLeg ? { isSteerLeg: true } : {}),
            ...(carriedToolFailLoopSteers > 0
              ? { priorToolFailLoopSteers: carriedToolFailLoopSteers }
              : {}),
            ...(passTracker ? { snapshotTracker: passTracker } : {}),
            ...(isRecapRun ? { maxToolStepsOverride: 0 } : {}),
            readRecordCache
          }
        )

        previousEnabledTools = input.enabledTools

        if (result.kind === 'recovering') {
          activeRun.recoveryCheckpoint = result.checkpoint
          activeRun.recoveringHarnessId = result.harnessId
          try {
            await sleep(
              Math.min(1_000 * 2 ** Math.max(0, result.checkpoint.recoveryAttempts - 1), 30_000),
              activeRun.abortController.signal
            )
          } catch (error) {
            if (!isAbortError(error)) {
              throw error
            }

            const timestamp = this.deps.timestamp()
            const checkpoint = activeRun.recoveryCheckpoint
            if (
              checkpoint &&
              (checkpoint.content || checkpoint.reasoning || checkpoint.textBlocks?.length)
            ) {
              const stoppedMessage: MessageRecord = {
                id: checkpoint.assistantMessageId,
                threadId: checkpoint.threadId,
                parentMessageId: checkpoint.requestMessageId,
                role: 'assistant',
                content: checkpoint.content,
                ...(checkpoint.reasoning ? { reasoning: checkpoint.reasoning } : {}),
                ...(checkpoint.textBlocks?.length ? { textBlocks: checkpoint.textBlocks } : {}),
                status: 'stopped',
                createdAt: timestamp
              }
              const latestThread = this.deps.requireThread(checkpoint.threadId)
              const updatedThread: ThreadRecord = {
                ...latestThread,
                updatedAt: timestamp,
                ...(checkpoint.updateHeadOnComplete
                  ? { headMessageId: checkpoint.assistantMessageId }
                  : {}),
                ...(checkpoint.content ? { preview: checkpoint.content.slice(0, 240) } : {})
              }
              this.deps.storage.saveThreadMessage({
                thread: latestThread,
                updatedThread,
                message: stoppedMessage
              })
              this.bindTerminalToolCallsToAssistant({
                threadId: checkpoint.threadId,
                runId: input.runId,
                assistantMessageId: checkpoint.assistantMessageId
              })
              this.deps.emit<MessageCompletedEvent>({
                type: 'message.completed',
                threadId: checkpoint.threadId,
                runId: input.runId,
                message: stoppedMessage
              })
              this.deps.emit<ThreadUpdatedEvent>({
                type: 'thread.updated',
                threadId: checkpoint.threadId,
                thread: updatedThread
              })
            }
            this.deps.storage.cancelRun({
              runId: input.runId,
              completedAt: timestamp,
              ...usageFieldsFrom(accumulatedUsage)
            })
            this.emitCancelledHarnessFinished({
              threadId: input.thread.id,
              runId: input.runId,
              harnessId: activeRun.recoveringHarnessId
            })
            this.deps.emit<RunCancelledEvent>({
              type: 'run.cancelled',
              threadId: input.thread.id,
              runId: input.runId,
              requestMessageId: currentRequestMessageId
            })
            result = { kind: 'cancelled' }
            break
          }
          continue
        }

        activeRun.recoveryCheckpoint = undefined
        activeRun.recoveringHarnessId = undefined

        if (result.kind === 'completed') {
          if (isRecapRun) {
            const text = (recapStorage as EphemeralStorage).lastAssistantContent ?? null
            if (text) {
              const thread = this.deps.storage.getThread(currentThread.id)
              if (thread) {
                this.deps.storage.updateThread({ ...thread, recapText: text })
              }
            }
            activeRun?.recapResolve?.(text)
            activeRun!.recapResolve = undefined
            this.deps.emit<RunCompletedEvent>({
              type: 'run.completed',
              threadId: input.thread.id,
              runId: input.runId,
              requestMessageId: currentRequestMessageId,
              recap: true
            })
            break
          }
          // Re-read the persisted thread so headMessageId reflects the
          // assistant reply, not the pre-run snapshot.
          const persistedThread = this.deps.storage.getThread(currentThread.id)
          if (persistedThread) {
            this.memoryScheduler.onRunCompleted(persistedThread, result.usedRememberTool)
          }
        }

        // Safe steer: the stream ended cleanly at a turn boundary and a user
        // steer is waiting. Persist the steer message and continue the loop
        // so the next executeServerRun iteration starts from the steer.
        if (result.kind === 'steer-pending') {
          carriedSnapshotTracker = result.snapshotTracker
          if (!activeRun?.pendingSteerInput) {
            // The steer was cancelled (e.g. user stopped the run) while the
            // model was finishing. The cancel path in executeServerRun never ran
            // (the abort arrived after throwIfAborted), so we must cancel the
            // run in storage ourselves and let the finally block fire
            // startQueuedFollowUpIfPresent.
            carriedSnapshotTracker?.dispose()
            carriedSnapshotTracker = undefined
            const steerPendingUsage = mergeUsageForTerminal(accumulatedUsage, result.usage)
            this.deps.storage.cancelRun({
              runId: input.runId,
              completedAt: this.deps.timestamp(),
              ...usageFieldsFrom(steerPendingUsage)
            })
            this.deps.emit<RunCancelledEvent>({
              type: 'run.cancelled',
              threadId: input.thread.id,
              runId: input.runId,
              requestMessageId: currentRequestMessageId
            })
            result = { kind: 'cancelled' }
            break
          }

          // Point requestMessageId to the completed assistant message so
          // persistSteerMessage parents the steer as a child of the assistant
          // response — not a sibling. This ensures the model sees all previous
          // work (including tool calls and results) when processing the steer.
          activeRun.requestMessageId = result.assistantMessageId

          const steerThread = this.deps.requireThread(input.thread.id)
          const { userMessage } = persistSteerMessage(this.createSendChatFlowContext(), {
            content: activeRun.pendingSteerInput.content,
            images: activeRun.pendingSteerInput.images,
            attachments: activeRun.pendingSteerInput.attachments,
            messageId: activeRun.pendingSteerInput.messageId,
            runId: input.runId,
            runState: activeRun,
            thread: steerThread,
            timestamp: activeRun.pendingSteerInput.timestamp,
            hidden: activeRun.pendingSteerInput.hidden
          })

          this.emitThreadStateReplaced(input.thread.id)
          activeRun.pendingSteerInput = undefined
          activeRun.pendingSteerMessageId = undefined
          activeRun.executionPhase = 'generating'
          activeRun.requestMessageId = userMessage.id
          currentRequestMessageId = userMessage.id
          this.deps.storage.updateRunRequestMessageId(input.runId, userMessage.id)
          currentThread = this.deps.requireThread(input.thread.id)

          // Accumulate totals from this steer leg so the final completion
          // includes total token counts from all legs of the run.
          if (result.usage) {
            const u = result.usage
            accumulatedUsage = {
              promptTokens: u.promptTokens,
              completionTokens: (accumulatedUsage?.completionTokens ?? 0) + u.completionTokens,
              totalPromptTokens: (accumulatedUsage?.totalPromptTokens ?? 0) + u.totalPromptTokens,
              totalCompletionTokens:
                (accumulatedUsage?.totalCompletionTokens ?? 0) + u.totalCompletionTokens,
              cacheReadTokens: (accumulatedUsage?.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
              cacheWriteTokens:
                (accumulatedUsage?.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0)
            }
          }
          carriedToolFailLoopSteers = result.toolFailLoopSteersInjected ?? carriedToolFailLoopSteers
          isSteerLeg = true
          continue
        }

        // Cancel-with-steer: the stopped assistant message has been persisted
        // by executeServerRun. Now persist the steer message as its child and
        // queue it as a follow-up so startQueuedFollowUpIfPresent fires a new run.
        //
        // Guard: if pendingSteerInput was already cleared by a prior
        // steer-pending iteration (race: model finished before observing the
        // abort), the steer is already persisted — skip to avoid double-persist.
        if (result.kind === 'cancelled-with-steer') {
          if (activeRun.pendingSteerInput) {
            const steerThread = this.deps.requireThread(input.thread.id)
            const { updatedThread, userMessage } = persistSteerMessage(
              this.createSendChatFlowContext(),
              {
                content: result.steerInput.content,
                images: result.steerInput.images,
                attachments: result.steerInput.attachments,
                messageId: result.steerInput.messageId,
                runId: input.runId,
                runState: { ...activeRun, requestMessageId: result.stoppedMessageId },
                thread: steerThread,
                timestamp: result.steerInput.timestamp,
                hidden: result.steerInput.hidden
              }
            )
            const queuedThread: ThreadRecord = {
              ...updatedThread,
              queuedFollowUpMessageId: userMessage.id
            }
            if (activeRun.pendingSteerInput.reasoningEffort !== undefined) {
              queuedThread.queuedFollowUpReasoningEffort =
                activeRun.pendingSteerInput.reasoningEffort
            }
            this.deps.storage.updateThread(queuedThread)
            this.emitThreadStateReplaced(input.thread.id)
            activeRun.pendingSteerInput = undefined
          }
          result = { kind: 'cancelled', usage: result.usage }
          break
        }

        if (isRecapRun && (result.kind === 'cancelled' || result.kind === 'failed')) {
          activeRun?.recapResolve?.(null)
          activeRun!.recapResolve = undefined
          this.deps.emit<RunCancelledEvent>({
            type: 'run.cancelled',
            threadId: input.thread.id,
            runId: input.runId,
            requestMessageId: currentRequestMessageId,
            recap: true
          })
          break
        }

        if (result.kind !== 'restarted') {
          break
        }

        carriedSnapshotTracker = result.snapshotTracker
        // Accumulate totals from the restarted leg so they aren't lost if the
        // subsequent leg is cancelled or fails.
        if (result.usage) {
          const u = result.usage
          accumulatedUsage = {
            promptTokens: u.promptTokens,
            completionTokens: (accumulatedUsage?.completionTokens ?? 0) + u.completionTokens,
            totalPromptTokens: (accumulatedUsage?.totalPromptTokens ?? 0) + u.totalPromptTokens,
            totalCompletionTokens:
              (accumulatedUsage?.totalCompletionTokens ?? 0) + u.totalCompletionTokens,
            cacheReadTokens: (accumulatedUsage?.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
            cacheWriteTokens: (accumulatedUsage?.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0)
          }
        }

        const nextRequestMessageId = activeRun.pendingSteerMessageId ?? result.nextRequestMessageId

        activeRun.pendingSteerMessageId = undefined
        activeRun.pendingSteerInput = undefined
        activeRun.executionPhase = 'generating'
        activeRun.requestMessageId = nextRequestMessageId
        currentRequestMessageId = nextRequestMessageId
        this.deps.storage.updateRunRequestMessageId(input.runId, nextRequestMessageId)
        currentThread = this.deps.requireThread(input.thread.id)
        isSteerLeg = true
        this.emitThreadStateReplaced(currentThread.id)
      }
    } catch (error) {
      const recapRun = this.activeRuns.get(input.runId)
      if (recapRun?.recap) {
        recapRun.recapResolve?.(null)
        recapRun.recapResolve = undefined
        this.deps.emit<RunCancelledEvent>({
          type: 'run.cancelled',
          threadId: input.thread.id,
          runId: input.runId,
          requestMessageId: currentRequestMessageId,
          recap: true
        })
        result = { kind: 'failed' }
      } else {
        const persistedRun = this.deps.storage.getRun(input.runId)

        if (!persistedRun || persistedRun.status !== 'running') {
          throw error
        }

        const timestamp = this.deps.timestamp()
        const message = error instanceof Error ? error.message : String(error)
        this.deps.storage.failRun({
          runId: input.runId,
          completedAt: timestamp,
          error: message,
          ...usageFieldsFrom(accumulatedUsage)
        })
        this.deps.emit<RunFailedEvent>({
          type: 'run.failed',
          threadId: input.thread.id,
          runId: input.runId,
          error: message
        })
        result = { kind: 'failed' }
      }
    } finally {
      // Resolve any dangling recap promise on cancellation/unexpected exit.
      const finalRun = this.activeRuns.get(input.runId)
      if (finalRun?.recapResolve) {
        finalRun.recapResolve(null)
        finalRun.recapResolve = undefined
      }

      // Dispose the carried tracker if it wasn't consumed by the next leg
      // (e.g. the loop exited via catch or the run was cancelled between legs).
      carriedSnapshotTracker?.dispose()
      carriedSnapshotTracker = undefined

      this.activeRuns.delete(input.runId)
      if (this.activeRunByThread.get(input.thread.id) === input.runId) {
        this.activeRunByThread.delete(input.thread.id)
      }
      this.activeRunTasks.delete(input.runId)

      const wasRecap = finalRun?.recap === true
      if (
        !wasRecap &&
        !this.isClosing &&
        result.kind !== 'restarted' &&
        result.kind !== 'steer-pending'
      ) {
        this.startQueuedFollowUpIfPresent(input.thread.id)
      }
    }
  }

  /** Cancel pending memory distillation for a thread (e.g. on delete/archive). */
  cancelMemoryDistillation(threadId: string): void {
    this.memoryScheduler.cancelThread(threadId)
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

    const thread = this.deps.storage.getThread(threadId)
    if (!thread) {
      return null
    }
    const queuedMessageId = thread.queuedFollowUpMessageId
    if (!queuedMessageId) {
      if (
        thread.queuedFollowUpEnabledTools ||
        thread.queuedFollowUpEnabledSkillNames ||
        thread.queuedFollowUpReasoningEffort
      ) {
        const clearedThread: ThreadRecord = {
          ...thread,
          updatedAt: this.deps.timestamp()
        }
        delete clearedThread.queuedFollowUpEnabledTools
        delete clearedThread.queuedFollowUpEnabledSkillNames
        delete clearedThread.queuedFollowUpReasoningEffort
        this.deps.storage.updateThread(clearedThread)
      }
      return null
    }

    const threadMessages = this.deps.loadThreadMessages(threadId)
    const queuedMessage = threadMessages.find(
      (message) => message.id === queuedMessageId && message.role === 'user'
    )
    if (!queuedMessage) {
      const clearedThread: ThreadRecord = {
        ...thread,
        updatedAt: this.deps.timestamp()
      }
      delete clearedThread.queuedFollowUpEnabledTools
      delete clearedThread.queuedFollowUpEnabledSkillNames
      delete clearedThread.queuedFollowUpReasoningEffort
      delete clearedThread.queuedFollowUpMessageId

      this.deps.storage.updateThread(clearedThread)
      return null
    }

    const wouldCycleQueuedFollowUpParent = wouldCreateParentCycle(
      threadMessages,
      queuedMessage.id,
      thread.headMessageId
    )
    if (wouldCycleQueuedFollowUpParent) {
      console.warn('[yachiyo][thread-tree] skipped cyclic queued follow-up reparent', {
        messageId: queuedMessage.id,
        threadHeadMessageId: thread.headMessageId,
        threadId
      })
    }
    const nextQueuedParentMessageId = wouldCycleQueuedFollowUpParent
      ? queuedMessage.parentMessageId
      : thread.headMessageId
    const reparentedQueuedMessage = withParentMessageId(queuedMessage, nextQueuedParentMessageId)
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
    delete updatedThread.queuedFollowUpEnabledSkillNames
    delete updatedThread.queuedFollowUpReasoningEffort
    delete updatedThread.queuedFollowUpMessageId

    this.deps.storage.updateThread(updatedThread)
    const reasoningEffort = thread.queuedFollowUpReasoningEffort

    const enabledTools = thread.queuedFollowUpEnabledTools
      ? [...thread.queuedFollowUpEnabledTools]
      : resolveEnabledTools(undefined, this.deps.readConfig().enabledTools)
    const enabledSkillNames =
      thread.queuedFollowUpEnabledSkillNames === undefined
        ? undefined
        : normalizeSkillNames(thread.queuedFollowUpEnabledSkillNames)
    const runId = this.deps.createId()

    return {
      createdAt: timestamp,
      enabledTools,
      enabledSkillNames,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
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

    startActiveRun(this.createActiveRunStartContext(), {
      enabledTools: prepared.enabledTools,
      enabledSkillNames: prepared.enabledSkillNames,
      reasoningEffort: prepared.reasoningEffort,
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
