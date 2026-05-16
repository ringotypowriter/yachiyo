import type {
  BackgroundTaskStartedEvent,
  SubagentProgressEvent,
  ThreadRecord,
  ToolCallName
} from '../../../../../../shared/yachiyo/protocol.ts'
import { isModelImageCapable } from '../../../../../../shared/yachiyo/providerConfig.ts'
import { collectMessagePath } from '../../../../../../shared/yachiyo/threadTree.ts'
import { toEffectiveProviderSettings } from '../../../../settings/settingsStore.ts'
import type { BackgroundBashManager } from '../../background/backgroundBashManager.ts'
import type { ActiveRunLoopInput } from '../active/activeRunStart.ts'
import { sendActiveRunSteer, type SendChatFlowContext } from '../chat/sendChatFlow.ts'
import type { RunExecutionDeps } from '../execution/runExecutionTypes.ts'
import type { BackgroundTaskRunContext, RunDomainDeps, RunState } from '../runTypes.ts'

export interface RunExecutionDepsContext {
  deps: RunDomainDeps
  activeRuns: Map<string, RunState>
  activeRunByThread: Map<string, string>
  activeRunTasks: Map<string, Promise<void>>
  backgroundTaskRunContext: Map<string, BackgroundTaskRunContext>
  backgroundBashManager: BackgroundBashManager
  createSendChatFlowContext: () => SendChatFlowContext
  setLastRunEnabledTools: (enabledTools: ToolCallName[]) => void
}

export interface BuildRunExecutionDepsInput {
  loopInput: ActiveRunLoopInput
  currentThread: ThreadRecord
  activeRun: RunState
  isRecapRun: boolean
  storage: RunExecutionDeps['storage']
  emit: RunExecutionDeps['emit']
}

export function buildRunExecutionDeps(
  context: RunExecutionDepsContext,
  input: BuildRunExecutionDepsInput
): RunExecutionDeps {
  const { deps } = context

  return {
    storage: input.storage,
    createId: deps.createId,
    timestamp: deps.timestamp,
    emit: input.emit,
    createModelRuntime: deps.createModelRuntime,
    ensureThreadWorkspace: deps.ensureThreadWorkspace,
    buildMemoryLayerEntries: async (memoryContext) => {
      if (memoryContext.thread.privacyMode || input.isRecapRun) {
        return { entries: [], recallDecision: undefined }
      }
      const branchHistory = collectMessagePath(
        deps.loadThreadMessages(memoryContext.thread.id),
        memoryContext.requestMessageId
      )
      const result = await deps.memoryService.recallForContext({
        history: branchHistory,
        now: memoryContext.thread.updatedAt,
        signal: memoryContext.signal,
        thread: memoryContext.thread,
        userQuery: memoryContext.userQuery
      })
      const persistedThread = deps.requireThread(memoryContext.thread.id)
      deps.storage.updateThread({
        ...persistedThread,
        memoryRecall: result.thread.memoryRecall
      })
      return {
        entries: result.entries,
        recallDecision: result.decision
      }
    },
    fetchImpl: deps.fetchImpl,
    webExternalFetchImpl: deps.webExternalFetchImpl,
    loadBrowserSnapshot: deps.loadBrowserSnapshot,
    memoryService: deps.memoryService,
    sourceQueryExecutor: deps.sourceQueryExecutor,
    searchService: deps.searchService,
    webSearchService: deps.webSearchService,
    readSoulDocument: deps.readSoulDocument,
    readUserDocument: deps.readUserDocument,
    readThread: deps.requireThread,
    readConfig: deps.readConfig,
    readSettings: () =>
      toEffectiveProviderSettings(
        deps.readConfig(),
        deps.requireThread(input.currentThread.id).modelOverride
      ),
    loadThreadMessages: input.isRecapRun
      ? (threadId: string) => {
          const msgs = deps.loadThreadMessages(threadId)
          if (threadId === input.currentThread.id && input.activeRun.recapUserMessage) {
            return [...msgs, input.activeRun.recapUserMessage]
          }
          return msgs
        }
      : deps.loadThreadMessages,
    loadThreadToolCalls: deps.loadThreadToolCalls,
    listSkills: deps.listSkills,
    jotdownStore: deps.jotdownStore,
    imageToTextService: deps.imageToTextService,
    isModelImageCapable: resolveCurrentModelImageCapability(deps, input.currentThread),
    onEnabledToolsUsed: (enabledTools) => {
      context.setLastRunEnabledTools(enabledTools)
    },
    onExecutionPhaseChange: (phase) => {
      const currentRun = context.activeRuns.get(input.loopInput.runId)
      if (!currentRun) {
        return
      }

      currentRun.executionPhase = phase
    },
    onSnapshotTrackerReady: (snapshotTracker) => {
      const currentRun = context.activeRuns.get(input.loopInput.runId)
      if (currentRun) {
        currentRun.snapshotTracker = snapshotTracker
      }
    },
    onAssistantMessagePersisted: async (messageId) => {
      const currentRun = context.activeRuns.get(input.loopInput.runId)
      if (!currentRun?.snapshotTracker) {
        return
      }

      await currentRun.snapshotTracker.markRestorePoint(messageId)
      currentRun.workspaceRestorePointMessageIds ??= new Set<string>()
      currentRun.workspaceRestorePointMessageIds.add(messageId)
    },
    onAskUserHandlerReady: (handler) => {
      const currentRun = context.activeRuns.get(input.loopInput.runId)
      if (currentRun) {
        currentRun.answerToolQuestion = handler
      }
    },
    hasPendingSteer: () => {
      const currentRun = context.activeRuns.get(input.loopInput.runId)
      return currentRun?.pendingSteerInput != null
    },
    injectPendingSteer: (steerInput) => {
      const activeRun = context.activeRuns.get(input.loopInput.runId)
      if (!activeRun) {
        return
      }
      sendActiveRunSteer(context.createSendChatFlowContext(), {
        activeRunId: input.loopInput.runId,
        content: steerInput.content,
        enabledSkillNames: activeRun.enabledSkillNames,
        runTrigger: input.loopInput.runTrigger,
        images: [],
        attachments: [],
        messageId: deps.createId(),
        thread: input.currentThread
      })
    },
    onSubagentProgress: (event) => {
      deps.emit<SubagentProgressEvent>({
        type: 'subagent.progress',
        threadId: input.loopInput.thread.id,
        runId: input.loopInput.runId,
        delegationId: event.delegationId,
        chunk: event.chunk
      })
    },
    onBackgroundBashStarted: async (task) => {
      context.backgroundTaskRunContext.set(
        task.taskId,
        buildBackgroundTaskRunContext(input.loopInput)
      )
      try {
        await context.backgroundBashManager.startTask({
          ...task,
          threadId: task.threadId
        })
        deps.emit<BackgroundTaskStartedEvent>({
          type: 'background-task.started',
          threadId: task.threadId,
          taskId: task.taskId,
          command: task.command,
          startedAt: deps.timestamp()
        })
      } catch (error) {
        context.backgroundTaskRunContext.delete(task.taskId)
        throw error
      }
    },
    onBackgroundBashAdopted: async (task) => {
      context.backgroundTaskRunContext.set(
        task.taskId,
        buildBackgroundTaskRunContext(input.loopInput)
      )
      try {
        await context.backgroundBashManager.adoptTask({
          taskId: task.taskId,
          command: task.command,
          cwd: task.cwd,
          logPath: task.logPath,
          ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
          threadId: task.threadId,
          child: task.child,
          initialOutput: task.initialOutput,
          ...(task.initialOutputAlreadyOnDisk ? { initialOutputAlreadyOnDisk: true } : {})
        })
        deps.emit<BackgroundTaskStartedEvent>({
          type: 'background-task.started',
          threadId: task.threadId,
          taskId: task.taskId,
          command: task.command,
          startedAt: deps.timestamp()
        })
      } catch (error) {
        context.backgroundTaskRunContext.delete(task.taskId)
        throw error
      }
    },
    getCompletedBackgroundBashTask: (taskId) =>
      context.backgroundBashManager.getCompletedTask(taskId),
    onTerminalState: () => {
      context.activeRuns.delete(input.loopInput.runId)
      if (context.activeRunByThread.get(input.loopInput.thread.id) === input.loopInput.runId) {
        context.activeRunByThread.delete(input.loopInput.thread.id)
      }
      context.activeRunTasks.delete(input.loopInput.runId)
    }
  }
}

function buildBackgroundTaskRunContext(input: ActiveRunLoopInput): BackgroundTaskRunContext {
  return {
    enabledTools: input.enabledTools,
    ...(input.enabledSkillNames ? { enabledSkillNames: input.enabledSkillNames } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    runTrigger: input.runTrigger,
    ...(input.channelHint ? { channelHint: input.channelHint } : {}),
    ...(input.extraTools ? { extraTools: input.extraTools } : {})
  }
}

function resolveCurrentModelImageCapability(
  deps: RunDomainDeps,
  currentThread: ThreadRecord
): boolean {
  const cfg = deps.readConfig()
  const effective =
    deps.requireThread(currentThread.id).modelOverride ??
    cfg.defaultModel ??
    (() => {
      const primary = cfg.providers.find((p) => p.modelList.enabled.length > 0) ?? cfg.providers[0]
      return primary
        ? { providerName: primary.name, model: primary.modelList.enabled[0] ?? '' }
        : undefined
    })()
  if (!effective) return true
  return isModelImageCapable(cfg, effective.providerName, effective.model)
}
