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
  SubagentSnapshot,
  SubagentToolCallDetails,
  ThreadSnapshot,
  ThreadRecord,
  ThreadUpdatedEvent,
  ToolCallUpdatedEvent,
  ToolCallRecord,
  YachiyoServerEvent
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
import {
  BackgroundBashManager,
  type BackgroundBashLogTarget
} from '../background/backgroundBashManager.ts'
import { resolveRunModeEnabledToolsForInput } from '../config/configDomain.ts'
import { resolveRunModeId } from '@yachiyo/shared/toolModes'
import { isLatestRunPlanMode } from '@yachiyo/shared/planMode'
import { RECAP_PROMPT } from './recap/recapPrompt.ts'
import { executeServerRun } from './execution/executeServerRun.ts'
import type { ExecuteRunInput, ExecuteRunResult } from './execution/runExecutionTypes.ts'
import { ReadRecordCache } from '../../../tools/agentTools.ts'
import { SnapshotTracker } from '../../../services/fileSnapshot/snapshotTracker.ts'
import { runAcpChatThread } from '../../../runtime/acp/acpChatRuntime.ts'
import { resolveRetryRequest } from '../threads/threadDomain.ts'
import { SubagentManager } from '../subagents/subagentManager.ts'
import { sleep } from '../../../channels/shared/connectionRetry.ts'
import { createRunEventMetadata } from '../shared/runEventMetadata.ts'
import { INTERRUPTED_RUN_ERROR, SHUTDOWN_RUN_ERROR, isAbortError } from '../shared/shared.ts'
import {
  type BackgroundTaskRunContext,
  type InternalSendChatInput,
  type RunDomainDeps,
  type RunState
} from './runTypes.ts'
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
  prepareRecoveredRuns,
  projectQueuedFollowUpDraftSnapshot,
  projectQueuedFollowUpDraftsBootstrap,
  resumeDeferredRecoveredRuns,
  scheduleRecoveredRuns,
  startQueuedFollowUpIfPresent,
  type QueuedFollowUpDraft,
  type FollowUpQueueContext
} from './queue/followUpQueue.ts'
import { ThreadTitleGenerationRunner } from './title/threadTitleGeneration.ts'
import { SeamlessHandoffCoordinator } from './handoff/seamlessHandoffCoordinator.ts'

export class YachiyoServerRunDomain {
  private readonly deps: RunDomainDeps
  private readonly activeRuns = new Map<string, RunState>()
  private readonly activeRunByThread = new Map<string, string>()
  private readonly activeRunTasks = new Map<string, Promise<void>>()
  private readonly debouncedSendChats = new Map<string, DebouncedSendChatEntry>()
  private readonly pendingRecoveredRuns = new Map<string, RunRecoveryCheckpoint>()
  private readonly queuedFollowUpDrafts = new Map<string, QueuedFollowUpDraft>()
  private readonly backgroundBashManager: BackgroundBashManager
  private readonly threadTitleRunner: ThreadTitleGenerationRunner
  private readonly subagentManager: SubagentManager
  private readonly latestSubagentSnapshots = new Map<string, SubagentSnapshot>()
  /**
   * Per-task snapshot of the launching run's channel/tooling context, captured at
   * `onBackgroundBashStarted`. We use it to call `sendChat` with the same `enabledTools`,
   * `enabledSkillNames`, `channelHint`, and `extraTools` (e.g. an owner-DM `replyTool`)
   * when the background task finishes, so the auto-delivered "background task completed"
   * user message can drive a model run that matches the original transport contract.
   */
  private readonly backgroundTaskRunContext = new Map<string, BackgroundTaskRunContext>()
  private readonly memoryScheduler: MemoryDistillationScheduler
  private readonly seamlessHandoffCoordinator: SeamlessHandoffCoordinator
  private readonly readRecordCaches = new Map<string, ReadRecordCache>()
  private lastRunEnabledTools: string[] | null
  private lastRunMode: RunModeId | null
  private isClosing = false
  private runAdmissionOwnerId: string | undefined

  constructor(deps: RunDomainDeps) {
    this.deps = deps
    this.backgroundBashManager = new BackgroundBashManager(deps.processBroker)
    this.lastRunEnabledTools = null
    this.lastRunMode = null
    this.subagentManager = new SubagentManager({
      createId: deps.createId,
      timestamp: deps.timestamp,
      emit: deps.emit as unknown as (event: YachiyoServerEvent) => void,
      onSnapshot: (snapshot) => this.persistSubagentSnapshot(snapshot),
      runnerFactory: () => {
        throw new Error(
          'Worker subagent launches must provide an explicit per-launch runnerFactory.'
        )
      },
      deliverToParent: async (input) => {
        if (this.isClosing) return
        const parentDeliveryContext = input.parentDeliveryContext
        if (!parentDeliveryContext) {
          throw new Error(`Subagent "${input.agentId}" is missing parent delivery context.`)
        }
        if (
          !this.deps.storage.getThread(input.parentThreadId) &&
          this.deps.storage.getArchivedThread(input.parentThreadId)
        ) {
          this.persistArchivedSubagentDelivery(input)
          return
        }
        const deliveryInput = {
          threadId: input.parentThreadId,
          content:
            input.kind === 'initial-result'
              ? `[Worker ${input.agentId} initial result]\n\n${input.message}`
              : `[Message from Worker ${input.agentId}]\n\n${input.message}`,
          hidden: true,
          toolPreset: parentDeliveryContext.enabledTools,
          ...(parentDeliveryContext.enabledSkillNames
            ? { enabledSkillNames: parentDeliveryContext.enabledSkillNames }
            : {}),
          runMode: parentDeliveryContext.runMode,
          ...(parentDeliveryContext.reasoningEffort !== undefined
            ? { reasoningEffort: parentDeliveryContext.reasoningEffort }
            : {}),
          runTrigger: parentDeliveryContext.runTrigger,
          ...(parentDeliveryContext.channelHint
            ? { channelHint: parentDeliveryContext.channelHint }
            : {}),
          ...(parentDeliveryContext.extraTools
            ? { extraTools: parentDeliveryContext.extraTools }
            : {})
        }
        try {
          await this.sendChat({ ...deliveryInput, mode: 'steer' })
        } catch {
          await this.sendChat({ ...deliveryInput, mode: 'follow-up' })
        }
      },
      getParentState: (threadId) => (this.hasNonRecapActiveRun(threadId) ? 'running' : 'idle')
    })
    this.threadTitleRunner = new ThreadTitleGenerationRunner(deps)
    this.seamlessHandoffCoordinator = new SeamlessHandoffCoordinator(deps)
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
  }): BackgroundBashLogTarget | undefined {
    return this.backgroundBashManager.getLogTarget(input.threadId, input.taskId)
  }

  cancelBackgroundTask(taskId: string): boolean {
    return this.backgroundBashManager.cancelTask(taskId)
  }

  private persistSubagentSnapshot(
    snapshot: SubagentSnapshot,
    persistedToolCall?: ToolCallRecord,
    emit = true
  ): ToolCallRecord | undefined {
    const previousSnapshot = this.latestSubagentSnapshots.get(snapshot.agentId)
    if (previousSnapshot && previousSnapshot.updatedAt > snapshot.updatedAt) return undefined
    this.latestSubagentSnapshots.set(snapshot.agentId, snapshot)

    const toolCall =
      persistedToolCall ??
      this.deps
        .loadThreadToolCalls(snapshot.parentThreadId)
        .find(
          (candidate) => candidate.id === snapshot.agentId && candidate.toolName === 'delegateTask'
        )
    if (!toolCall) return undefined

    const existingDetails = toolCall.details
    if (
      existingDetails &&
      (typeof existingDetails !== 'object' ||
        !('kind' in existingDetails) ||
        existingDetails.kind !== 'subagent')
    ) {
      return undefined
    }
    const details: SubagentToolCallDetails =
      existingDetails && typeof existingDetails === 'object' && 'kind' in existingDetails
        ? (existingDetails as SubagentToolCallDetails)
        : {
            kind: 'subagent',
            agentId: snapshot.agentId,
            agentName: snapshot.agentName,
            agentType: snapshot.agentType,
            codeName: snapshot.codeName,
            workspacePath: snapshot.workspacePath,
            lifecycleState: snapshot.state
          }
    const updatedDetails: SubagentToolCallDetails = {
      ...details,
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
      agentType: snapshot.agentType,
      codeName: snapshot.codeName,
      workspacePath: snapshot.workspacePath,
      lifecycleState: snapshot.state,
      ...(snapshot.lastOutput !== undefined ? { lastOutput: snapshot.lastOutput } : {}),
      ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
      ...(details.snapshotId
        ? { snapshotId: details.snapshotId }
        : { snapshotId: snapshot.agentId })
    }
    const updatedToolCall: ToolCallRecord = {
      ...toolCall,
      details: updatedDetails,
      ...(snapshot.lastOutput !== undefined ? { outputSummary: snapshot.lastOutput } : {})
    }
    this.deps.storage.updateToolCall(updatedToolCall)
    if (emit) {
      this.deps.emit<ToolCallUpdatedEvent>({
        type: 'tool.updated',
        threadId: snapshot.parentThreadId,
        ...(updatedToolCall.runId ? { runId: updatedToolCall.runId } : {}),
        toolCall: updatedToolCall
      })
    }
    return updatedToolCall
  }

  private reconcilePersistedSubagentToolCall(toolCall: ToolCallRecord): ToolCallRecord {
    if (toolCall.toolName !== 'delegateTask') return toolCall
    const snapshot = this.latestSubagentSnapshots.get(toolCall.id)
    if (!snapshot || snapshot.parentThreadId !== toolCall.threadId) return toolCall
    return this.persistSubagentSnapshot(snapshot, toolCall, false) ?? toolCall
  }
  private persistArchivedSubagentDelivery(input: {
    agentId: string
    parentThreadId: string
    message: string
  }): void {
    const toolCall = this.deps.storage
      .listThreadToolCalls(input.parentThreadId)
      .find((candidate) => candidate.id === input.agentId && candidate.toolName === 'delegateTask')
    if (!toolCall || !toolCall.details || typeof toolCall.details !== 'object') return
    if (!('kind' in toolCall.details) || toolCall.details.kind !== 'subagent') return

    const updatedToolCall: ToolCallRecord = {
      ...toolCall,
      details: {
        ...toolCall.details,
        lastOutput: input.message
      },
      outputSummary: input.message
    }
    this.deps.storage.updateToolCall(updatedToolCall)
    this.deps.emit<ToolCallUpdatedEvent>({
      type: 'tool.updated',
      threadId: input.parentThreadId,
      ...(toolCall.runId ? { runId: toolCall.runId } : {}),
      toolCall: updatedToolCall
    })
  }

  listSubagents(threadId?: string): SubagentSnapshot[] {
    return this.subagentManager.list(threadId)
  }

  cancelSubagent(agentId: string): boolean {
    return this.subagentManager.cancel(agentId)
  }

  closeSubagent(agentId: string): boolean {
    return this.subagentManager.closeIdle(agentId)
  }

  cancelRunningSubagents(threadId: string): number {
    return this.subagentManager.cancelRunningByThread(threadId)
  }

  async closeSubagentsForThread(threadId: string): Promise<void> {
    await this.subagentManager.closeThread(threadId)
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

  closeRunAdmissionAndGetActiveRunIds(ownerId: string): string[] {
    // This method does not await: closing admission and reading the runtime's
    // authoritative active map are one event-loop operation in both the
    // in-process server and utility-process RPC modes.
    if (this.runAdmissionOwnerId && this.runAdmissionOwnerId !== ownerId) {
      throw new Error('Yachiyo runtime run admission is already closed by another install attempt.')
    }
    this.runAdmissionOwnerId = ownerId
    return this.listActiveRunIds()
  }

  openRunAdmission(ownerId: string): void {
    if (this.runAdmissionOwnerId !== ownerId) {
      return
    }

    this.runAdmissionOwnerId = undefined
    const followUpQueueContext = this.createFollowUpQueueContext()
    resumeDeferredRecoveredRuns(followUpQueueContext)
    for (const threadId of [...this.queuedFollowUpDrafts.keys()]) {
      startQueuedFollowUpIfPresent(followUpQueueContext, threadId)
    }
  }

  private assertRunAdmissionOpen(): void {
    if (this.runAdmissionOwnerId) {
      throw new Error('Yachiyo runtime is not accepting new runs while an update is installing.')
    }
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
    this.seamlessHandoffCoordinator.abort()

    await this.backgroundBashManager.close()

    if (this.activeRunTasks.size > 0) {
      await Promise.allSettled(this.activeRunTasks.values())
    }
    await this.subagentManager.close()
    await this.threadTitleRunner.close()
    await this.memoryScheduler.close()

    this.recoverInterruptedRuns(SHUTDOWN_RUN_ERROR)
    this.activeRuns.clear()
    this.activeRunByThread.clear()
    this.activeRunTasks.clear()
    this.debouncedSendChats.clear()
    this.pendingRecoveredRuns.clear()
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
      },
      assertRunAdmissionOpen: () => this.assertRunAdmissionOpen()
    }
  }

  private createActiveRunStartContext(): ActiveRunStartContext {
    return {
      deps: this.deps,
      activeRuns: this.activeRuns,
      activeRunByThread: this.activeRunByThread,
      activeRunTasks: this.activeRunTasks,
      isClosing: () => this.isClosing,
      isRunAdmissionOpen: () => this.runAdmissionOwnerId === undefined,
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
      subagentManager: this.subagentManager,
      onSubagentToolCallPersisted: (toolCall) => this.reconcilePersistedSubagentToolCall(toolCall),
      createSendChatFlowContext: () => this.createSendChatFlowContext(),
      setLastRunEnabledTools: (enabledTools) => {
        this.lastRunEnabledTools = [...enabledTools]
      },
      setLastRunMode: (runMode) => {
        this.lastRunMode = runMode
      },
      seamlessHandoffCoordinator: this.seamlessHandoffCoordinator
    }
  }

  private createRunLoopSteerContext(): RunLoopSteerContext {
    return {
      deps: this.deps,
      createSendChatFlowContext: () => this.createSendChatFlowContext(),
      createFollowUpQueueContext: () => this.createFollowUpQueueContext(),
      seamlessHandoffCoordinator: this.seamlessHandoffCoordinator
    }
  }

  private createBackgroundTaskLifecycleContext(): BackgroundTaskLifecycleContext {
    return {
      deps: this.deps,
      backgroundTaskRunContext: this.backgroundTaskRunContext,
      isClosing: () => this.isClosing,
      sendChat: (input) => this.sendChat(input),
      deliverToAgent: ({ agentId, threadId, message }) => {
        this.subagentManager.send({
          from: { kind: 'parent', threadId },
          to: agentId,
          message
        })
      }
    }
  }

  private createFollowUpQueueContext(): FollowUpQueueContext {
    return {
      deps: this.deps,
      activeRunByThread: this.activeRunByThread,
      pendingRecoveredRuns: this.pendingRecoveredRuns,
      queuedFollowUpDrafts: this.queuedFollowUpDrafts,
      isClosing: () => this.isClosing,
      isRunAdmissionOpen: () => this.runAdmissionOwnerId === undefined,
      startActiveRun: (input) => {
        startActiveRun(this.createActiveRunStartContext(), input)
      },
      startRecoveredRun: (checkpoint) => {
        startRecoveredRun(this.createActiveRunStartContext(), checkpoint)
      }
    }
  }
  recoverOrphanedSubagents(
    toolCallsByThread: Record<string, ToolCallRecord[]>
  ): Record<string, ToolCallRecord[]> {
    let changed = false
    const recovered = Object.fromEntries(
      Object.entries(toolCallsByThread).map(([threadId, toolCalls]) => {
        const nextToolCalls = toolCalls.map((toolCall) => {
          const details = toolCall.details
          if (
            !details ||
            typeof details !== 'object' ||
            !('kind' in details) ||
            details.kind !== 'subagent' ||
            !('lifecycleState' in details) ||
            (details.lifecycleState !== 'starting' &&
              details.lifecycleState !== 'running' &&
              details.lifecycleState !== 'idle')
          ) {
            return toolCall
          }

          const recoveredToolCall: ToolCallRecord = {
            ...toolCall,
            details: {
              ...details,
              lifecycleState: 'interrupted',
              error: 'Agent was interrupted when the application restarted.'
            } as SubagentToolCallDetails
          }
          changed = true
          this.deps.storage.updateToolCall(recoveredToolCall)
          this.deps.emit<ToolCallUpdatedEvent>({
            type: 'tool.updated',
            threadId,
            ...(toolCall.runId ? { runId: toolCall.runId } : {}),
            toolCall: recoveredToolCall
          })
          return recoveredToolCall
        })
        return [threadId, nextToolCalls]
      })
    ) as Record<string, ToolCallRecord[]>
    return changed ? recovered : toolCallsByThread
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

  prepareRecoveredRuns(): RunRecoveryCheckpoint[] {
    return prepareRecoveredRuns(this.createFollowUpQueueContext())
  }

  scheduleRecoveredRuns(checkpoints: RunRecoveryCheckpoint[]): void {
    scheduleRecoveredRuns(this.createFollowUpQueueContext(), checkpoints)
  }

  async sendChat(input: InternalSendChatInput): Promise<ChatAccepted> {
    this.assertRunAdmissionOpen()
    return sendChatFlow(this.createSendChatFlowContext(), input)
  }

  deleteQueuedFollowUpDraft(input: { threadId: string; messageId: string }): ThreadSnapshot | null {
    return deleteQueuedFollowUpDraft(this.createFollowUpQueueContext(), input)
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
    this.assertRunAdmissionOpen()
    const thread = this.deps.requireThread(input.threadId)
    if (!getThreadCapabilities(thread).canRetry) {
      throw new Error('ACP threads do not support retry.')
    }
    if (this.hasNonRecapActiveRun(thread.id)) {
      throw new Error('This thread already has an active run.')
    }

    const runMode = resolveRunModeId({
      runMode: input.runMode,
      fallbackEnabledTools: thread.enabledTools,
      fallbackRunMode: thread.runMode ?? DEFAULT_RUN_MODE_ID
    })
    const enabledTools = resolveRunModeEnabledToolsForInput({
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
    this.assertRunAdmissionOpen()
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
      this.assertRunAdmissionOpen()
      const thread = this.deps.requireThread(input.threadId)
      if (thread.syncOriginDeviceId) return null
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
        content: RECAP_PROMPT,
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
            processingTier: isRecapRun ? 'standard' : 'priority',
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

        previousEnabledTools = this.lastRunEnabledTools ?? executionEnabledTools
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
            const text = (recapStorage as EphemeralStorage).lastAssistantContent?.trim() || null
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
