import type {
  BackgroundTaskLogAppendEvent,
  BackgroundTaskSnapshot,
  BootstrapPayload,
  ChatAccepted,
  ComposerReasoningSelection,
  CompactThreadAccepted,
  MessageCompletedEvent,
  MessageRecord,
  RunCancelledEvent,
  RunCompletedEvent,
  RunModeId,
  RetryAccepted,
  RetryInput,
  RunFailedEvent,
  RunCreatedEvent,
  SendChatInput,
  ThreadSnapshot,
  ThreadRecord,
  ThreadUpdatedEvent,
  ToolCallUpdatedEvent,
  ToolCallRecord,
  ToolCallName
} from '@yachiyo/shared/protocol'
import {
  DEFAULT_RUN_MODE_ID,
  getThreadCapabilities,
  normalizeSkillNames
} from '@yachiyo/shared/protocol'
import { summarizeMessagePreview } from '@yachiyo/shared/messageContent'
import {
  createMemoryDistillationScheduler,
  type MemoryDistillationScheduler
} from '../../../services/memory/memoryDistillationScheduler.ts'
import type { BootstrapState, RunRecoveryCheckpoint } from '../../../storage/storage.ts'
import { BackgroundBashManager } from '../background/backgroundBashManager.ts'
import { resolveRunModeEnabledToolsForInput } from '../config/configDomain.ts'
import { resolveRunModeId } from '@yachiyo/shared/toolModes'
import { isLatestRunPlanMode } from '@yachiyo/shared/planMode'
import { executeServerRun } from './execution/executeServerRun.ts'
import type { ExecuteRunInput, ExecuteRunResult } from './execution/runExecutionTypes.ts'
import { ReadRecordCache } from '../../../tools/agentTools.ts'
import { SnapshotTracker } from '../../../services/fileSnapshot/snapshotTracker.ts'
import { runAcpChatThread } from '../../../runtime/acp/acpChatRuntime.ts'
import { resolveRetryRequest } from '../threads/threadDomain.ts'
import { sleep } from '../../../channels/shared/connectionRetry.ts'
import { createRunEventMetadata } from '../shared/runEventMetadata.ts'
import { INTERRUPTED_RUN_ERROR, SHUTDOWN_RUN_ERROR, isAbortError } from '../shared/shared.ts'
import { type BackgroundTaskRunContext, type RunDomainDeps, type RunState } from './runTypes.ts'
import { createEphemeralStorageProxy, type EphemeralStorage } from './chat/ephemeralStorage.ts'
import { type DebouncedSendChatEntry } from './chat/sendChatDebounce.ts'
import { sendChatFlow, type SendChatFlowContext } from './chat/sendChatFlow.ts'
import { resolveEffectiveThreadMessages } from './chat/threadMessages.ts'
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
import { usageFieldsFrom } from './runUsageFields.ts'
import { accumulateRunLoopUsage } from './loop/runUsage.ts'
import { buildRunExecutionDeps, type RunExecutionDepsContext } from './loop/runExecutionDeps.ts'
import {
  handleCancelledWithSteerResult,
  handleSteerPendingResult,
  type RunLoopSteerContext
} from './loop/runLoopSteer.ts'
import {
  handleBackgroundBashCompleted,
  recoverOrphanedBackgroundToolCalls,
  type BackgroundTaskLifecycleContext
} from './background/backgroundTaskLifecycle.ts'
import {
  emitThreadStateReplaced,
  deleteQueuedFollowUpDraft,
  prepareRecoveredQueuedFollowUps,
  prepareRecoveredRuns,
  projectQueuedFollowUpDraftSnapshot,
  projectQueuedFollowUpDraftsBootstrap,
  projectQueuedFollowUpDraftThread,
  scheduleRecoveredQueuedFollowUps,
  scheduleRecoveredRuns,
  startQueuedFollowUpIfPresent,
  type QueuedFollowUpDraft,
  type FollowUpQueueContext
} from './queue/followUpQueue.ts'
import { ThreadTitleGenerationRunner } from './title/threadTitleGeneration.ts'

export class YachiyoServerRunDomain {
  private readonly deps: RunDomainDeps
  private readonly activeRuns = new Map<string, RunState>()
  private readonly activeRunByThread = new Map<string, string>()
  private readonly activeRunTasks = new Map<string, Promise<void>>()
  private readonly debouncedSendChats = new Map<string, DebouncedSendChatEntry>()
  private readonly queuedFollowUpDrafts = new Map<string, QueuedFollowUpDraft>()
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
  private lastRunMode: RunModeId | null
  private isClosing = false

  constructor(deps: RunDomainDeps) {
    this.deps = deps
    this.lastRunEnabledTools = null
    this.lastRunMode = null
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

  async restoreActiveRunBranchWorkspace(input: {
    threadId: string
    branchMessageIds: string[]
    branchWorkspacePath: string
  }): Promise<void> {
    const runId = this.activeRunByThread.get(input.threadId)
    if (!runId) {
      return
    }

    const run = this.activeRuns.get(runId)
    if (!run?.snapshotTracker || run.recap) {
      return
    }

    for (let index = input.branchMessageIds.length - 1; index >= 0; index -= 1) {
      const messageId = input.branchMessageIds[index]!
      if (run.workspaceRestorePointMessageIds?.has(messageId)) {
        await run.snapshotTracker.restorePointStateTo(input.branchWorkspacePath, messageId)
        return
      }
    }

    await run.snapshotTracker.restoreRunStartStateTo(input.branchWorkspacePath)
  }

  listActiveRunIds(): string[] {
    const runIds: string[] = []
    for (const [runId, run] of this.activeRuns) {
      if (!run.recap) runIds.push(runId)
    }
    return runIds
  }

  cancelActiveRuns(): void {
    for (const runId of this.listActiveRunIds()) {
      this.cancelRun({ runId })
    }
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
    this.queuedFollowUpDrafts.clear()
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
      queuedFollowUpDrafts: this.queuedFollowUpDrafts,
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
      },
      setLastRunMode: (runMode) => {
        this.lastRunMode = runMode
      }
    }
  }

  private createRunLoopSteerContext(): RunLoopSteerContext {
    return {
      deps: this.deps,
      createSendChatFlowContext: () => this.createSendChatFlowContext(),
      createFollowUpQueueContext: () => this.createFollowUpQueueContext()
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

  private createFollowUpQueueContext(): FollowUpQueueContext {
    return {
      deps: this.deps,
      activeRunByThread: this.activeRunByThread,
      queuedFollowUpDrafts: this.queuedFollowUpDrafts,
      isClosing: () => this.isClosing,
      startActiveRun: (input) => {
        startActiveRun(this.createActiveRunStartContext(), input)
      },
      startRecoveredRun: (checkpoint) => {
        startRecoveredRun(this.createActiveRunStartContext(), checkpoint)
      }
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

  recoverInterruptedRuns(error: string = INTERRUPTED_RUN_ERROR): void {
    this.deps.storage.recoverInterruptedRuns({
      error,
      finishedAt: this.deps.timestamp()
    })
    recoverOrphanedBackgroundToolCalls(this.createBackgroundTaskLifecycleContext())
  }

  prepareRecoveredQueuedFollowUps(): string[] {
    return prepareRecoveredQueuedFollowUps(this.createFollowUpQueueContext())
  }

  prepareRecoveredRuns(): RunRecoveryCheckpoint[] {
    return prepareRecoveredRuns(this.createFollowUpQueueContext())
  }

  scheduleRecoveredQueuedFollowUps(threadIds: string[]): void {
    scheduleRecoveredQueuedFollowUps(this.createFollowUpQueueContext(), threadIds)
  }

  scheduleRecoveredRuns(checkpoints: RunRecoveryCheckpoint[]): void {
    scheduleRecoveredRuns(this.createFollowUpQueueContext(), checkpoints)
  }

  async sendChat(input: SendChatInput): Promise<ChatAccepted> {
    return sendChatFlow(this.createSendChatFlowContext(), input)
  }

  deleteQueuedFollowUpDraft(input: { threadId: string; messageId: string }): ThreadSnapshot | null {
    return deleteQueuedFollowUpDraft(this.createFollowUpQueueContext(), input)
  }

  withQueuedFollowUpDraft(thread: ThreadRecord): ThreadRecord {
    return projectQueuedFollowUpDraftThread(this.queuedFollowUpDrafts, thread)
  }

  withQueuedFollowUpDraftSnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
    return projectQueuedFollowUpDraftSnapshot(this.queuedFollowUpDrafts, snapshot)
  }

  withQueuedFollowUpDraftsBootstrap(bootstrap: BootstrapState): BootstrapState
  withQueuedFollowUpDraftsBootstrap(bootstrap: BootstrapPayload): BootstrapPayload
  withQueuedFollowUpDraftsBootstrap(
    bootstrap: BootstrapState | BootstrapPayload
  ): BootstrapState | BootstrapPayload {
    return projectQueuedFollowUpDraftsBootstrap(this.queuedFollowUpDrafts, bootstrap)
  }

  async retryMessage(input: RetryInput): Promise<RetryAccepted> {
    const thread = this.deps.requireThread(input.threadId)
    if (!getThreadCapabilities(thread).canRetry) {
      throw new Error('ACP threads do not support retry.')
    }
    if (this.hasNonRecapActiveRun(thread.id)) {
      throw new Error('This thread already has an active run.')
    }

    const runMode = resolveRunModeId({
      enabledTools: input.enabledTools,
      runMode: input.runMode,
      fallbackEnabledTools: thread.enabledTools,
      fallbackRunMode: thread.runMode ?? DEFAULT_RUN_MODE_ID
    })
    const enabledTools = resolveRunModeEnabledToolsForInput({
      enabledTools: input.enabledTools,
      runMode,
      fallbackEnabledTools: thread.enabledTools
    })
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
      ...createRunEventMetadata({
        threadId: accepted.thread.id,
        runId: accepted.runId,
        requestMessageId: requestMessage.id,
        runTrigger: 'local'
      }),
      runMode
    })

    startActiveRun(this.createActiveRunStartContext(), {
      enabledTools,
      enabledSkillNames,
      runMode,
      reasoningEffort: input.reasoningEffort,
      runTrigger: 'local',
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
      ...createRunEventMetadata({
        threadId: input.destinationThread.id,
        runId,
        runTrigger: 'local'
      }),
      runMode: 'auto'
    })

    startAssistantOnlyRun(this.createActiveRunStartContext(), {
      runId,
      thread: input.destinationThread,
      sourceThreadId: input.sourceThread.id,
      sourceMessages: effectiveMessages,
      runMode: 'auto',
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
      const latestRun = this.deps.storage.listThreadRuns(input.threadId)[0]
      if (isLatestRunPlanMode({ latestRun, messages })) return null
      const lastPromptTokens = latestRun?.promptTokens ?? 0
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

      const runMode = thread.runMode ?? DEFAULT_RUN_MODE_ID
      const enabledTools = resolveRunModeEnabledToolsForInput({
        runMode,
        fallbackEnabledTools: thread.enabledTools
      })

      return new Promise<string | null>((resolve) => {
        startActiveRun(this.createActiveRunStartContext(), {
          enabledTools,
          runMode,
          runTrigger: 'local',
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
    let previousRunMode = input.previousRunMode ?? this.lastRunMode
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
                if (this.activeRunByThread.get(input.thread.id) === input.runId) {
                  this.activeRunByThread.delete(input.thread.id)
                }
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
        const executionEnabledTools = activeRun.enabledTools ?? input.enabledTools
        const executionRunMode = activeRun.runMode ?? input.runMode

        result = await executeServerRun(
          buildRunExecutionDeps(this.createRunExecutionDepsContext(), {
            loopInput: input,
            currentThread,
            activeRun,
            executionEnabledTools,
            executionRunMode,
            isRecapRun,
            storage: recapStorage,
            emit: recapEmit
          }),
          {
            abortController,
            enabledTools: executionEnabledTools,
            enabledSkillNames: activeRun.enabledSkillNames ?? input.enabledSkillNames,
            runMode: executionRunMode,
            reasoningEffort: activeRun.reasoningEffort ?? input.reasoningEffort,
            runTrigger: activeRun.runTrigger ?? input.runTrigger,
            inactivityTimeoutMs: this.deps.runInactivityTimeoutMs,
            channelHint: activeRun.channelHint ?? input.channelHint,
            extraTools: input.extraTools,
            previousEnabledTools,
            previousRunMode,
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
            ...(activeRun.agentStepCount !== undefined
              ? { priorAgentStepCount: activeRun.agentStepCount }
              : {}),
            readRecordCache
          }
        )

        previousEnabledTools = executionEnabledTools
        previousRunMode = executionRunMode
        this.lastRunMode = previousRunMode

        if (result.kind === 'recovering') {
          activeRun.recoveryCheckpoint = result.checkpoint
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
              const stoppedPreview = summarizeMessagePreview(stoppedMessage)
              const updatedThread: ThreadRecord = {
                ...latestThread,
                updatedAt: timestamp,
                ...(checkpoint.updateHeadOnComplete
                  ? { headMessageId: checkpoint.assistantMessageId }
                  : {}),
                ...(stoppedPreview ? { preview: stoppedPreview.slice(0, 240) } : {})
              }
              this.deps.storage.saveThreadMessage({
                thread: latestThread,
                updatedThread,
                message: stoppedMessage
              })
              if (activeRun.snapshotTracker) {
                await activeRun.snapshotTracker.markRestorePoint(stoppedMessage.id)
                activeRun.workspaceRestorePointMessageIds ??= new Set<string>()
                activeRun.workspaceRestorePointMessageIds.add(stoppedMessage.id)
              }
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
              ...createRunEventMetadata({
                threadId: input.thread.id,
                runId: input.runId,
                requestMessageId: currentRequestMessageId,
                runTrigger: activeRun?.runTrigger ?? input.runTrigger
              }),
              recap: true
            })
            break
          }
          // Re-read the persisted thread so headMessageId reflects the
          // assistant reply, not the pre-run snapshot.
          const persistedThread = this.deps.storage.getThread(currentThread.id)
          if (persistedThread) {
            this.memoryScheduler.onRunCompleted(persistedThread)
          }
        }

        if (result.kind === 'steer-pending') {
          const steerResult = await handleSteerPendingResult(this.createRunLoopSteerContext(), {
            accumulatedUsage,
            activeRun,
            carriedToolFailLoopSteers,
            currentRequestMessageId,
            loopInput: input,
            result
          })

          accumulatedUsage = steerResult.accumulatedUsage
          if (steerResult.kind === 'cancelled') {
            carriedSnapshotTracker = undefined
            result = steerResult.result
            break
          }

          carriedSnapshotTracker = steerResult.carriedSnapshotTracker
          carriedToolFailLoopSteers = steerResult.carriedToolFailLoopSteers
          currentRequestMessageId = steerResult.currentRequestMessageId
          currentThread = steerResult.currentThread
          isSteerLeg = true
          continue
        }

        if (result.kind === 'cancelled-with-steer') {
          result = handleCancelledWithSteerResult(this.createRunLoopSteerContext(), {
            activeRun,
            loopInput: input,
            result
          })
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
        accumulatedUsage = accumulateRunLoopUsage(accumulatedUsage, result.usage)

        const nextRequestMessageId = activeRun.pendingSteerMessageId ?? result.nextRequestMessageId

        activeRun.pendingSteerMessageId = undefined
        activeRun.pendingSteerInputs = undefined
        activeRun.executionPhase = 'generating'
        activeRun.requestMessageId = nextRequestMessageId
        currentRequestMessageId = nextRequestMessageId
        this.deps.storage.updateRunRequestMessageId(input.runId, nextRequestMessageId)
        currentThread = this.deps.requireThread(input.thread.id)
        isSteerLeg = true
        emitThreadStateReplaced(this.createFollowUpQueueContext(), currentThread.id)
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
        startQueuedFollowUpIfPresent(this.createFollowUpQueueContext(), input.thread.id)
      }
    }
  }

  /** Cancel pending memory distillation for a thread (e.g. on delete/archive). */
  cancelMemoryDistillation(threadId: string): void {
    this.memoryScheduler.cancelThread(threadId)
  }
}
