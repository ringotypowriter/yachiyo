import type { ToolSet } from 'ai'

import type {
  NotificationRequestEvent,
  SubagentFinishedEvent,
  SubagentStartedEvent,
  SubagentToolCallEvent,
  ThreadRecord,
  ThreadUpdatedEvent,
  TodoItemRecord,
  ToolCallRecord,
  ToolCallUpdatedEvent
} from '@yachiyo/shared/protocol'
import { resolveYachiyoUserPath } from '../../../../config/paths.ts'
import { readChannelsConfig } from '../../../../runtime/config/channelsConfig.ts'
import type { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import { createFilteredMemoryService } from '../../../../services/memory/memoryService.ts'
import { createAgentToolSet } from '../../../../tools/agentTools.ts'
import { createRunEventMetadata } from '../../shared/runEventMetadata.ts'
import type {
  DelegateTaskFinishedEvent,
  DelegateTaskProgressEvent,
  DelegateTaskStartedEvent,
  DelegateTaskToolCallEvent
} from '../../../../tools/agentTools.ts'
import type { PreparedServerRunContext } from '../context/prepareServerRunContext.ts'
import type { RunToolLifecycleState } from './runToolLifecycleState.ts'
import type { ExecuteRunInput, RunExecutionDeps } from './runExecutionTypes.ts'

type ExecutionPhase = 'generating' | 'tool-running' | 'waiting-for-user'

interface PendingUserAnswer {
  resolve: (answer: string) => void
  reject: (err: Error) => void
}

export interface CreateRunToolSetInput {
  advanceAgentStep: (options?: { notifyTodoReminder?: boolean }) => number
  createToolCall: (toolCall: ToolCallRecord) => void
  deps: RunExecutionDeps
  executionInput: ExecuteRunInput
  markProgress: () => void
  maxToolSteps: number
  pendingUserAnswers: Map<string, PendingUserAnswer>
  persistRecoveryCheckpoint: () => void
  preparedContext: PreparedServerRunContext
  setExecutionPhase: (phase: ExecutionPhase) => void
  snapshotTracker: SnapshotTracker
  subagentStartedAtByDelegationId: Map<string, string>
  toolLifecycle: RunToolLifecycleState
  updateToolCall: (toolCall: ToolCallRecord) => void
}

export function createRunToolSet(input: CreateRunToolSetInput): ToolSet | undefined {
  const {
    availableSkills,
    enabledSubagentProfiles,
    gitCtx,
    gitValidatedWorkspaces,
    subagentAvailableWorkspaces,
    isExternalChannel,
    isGuest,
    isLocalRunTrigger,
    isOwnerDm,
    modelEnabledTools,
    workspacePath,
    planModeDocument
  } = input.preparedContext
  const deps = input.deps
  const executionInput = input.executionInput
  const subagentsConfig = input.preparedContext.subagentsConfig
  const hasEnabledWorkerSubagents =
    subagentsConfig.mode === 'worker' && subagentsConfig.enabledNamedAgents.length > 0
  const hasEnabledAcpSubagents =
    subagentsConfig.mode === 'acp' && enabledSubagentProfiles.length > 0
  const canUseDelegateTask = hasEnabledWorkerSubagents
    ? true
    : (gitCtx.hasGit || gitValidatedWorkspaces.length > 0) && hasEnabledAcpSubagents
  const toolContext = {
    enabledTools: modelEnabledTools,
    threadId: executionInput.thread.id,
    workspacePath,
    sandboxed: isExternalChannel && !isOwnerDm,
    snapshotTracker: input.snapshotTracker,
    readRecordCache: executionInput.readRecordCache,
    imageToTextService: deps.imageToTextService,
    isModelImageCapable: deps.isModelImageCapable,
    runMode: input.preparedContext.runMode,
    ...(planModeDocument
      ? {
          writeRestriction: {
            absolutePath: planModeDocument.planAbsolutePath,
            relativePath: planModeDocument.planRelativePath,
            fallbackAbsolutePaths: planModeDocument.fallbackAbsolutePaths,
            skipReadBeforeOverwrite: true
          }
        }
      : {}),
    ...(deps.onBackgroundBashStarted
      ? {
          onBackgroundBashStarted: async (task) => {
            await deps.onBackgroundBashStarted?.({ ...task, threadId: executionInput.thread.id })
          }
        }
      : {}),
    ...(deps.onBackgroundBashAdopted
      ? {
          onBackgroundBashAdopted: async (task) => {
            await deps.onBackgroundBashAdopted?.({ ...task, threadId: executionInput.thread.id })
          }
        }
      : {})
  }

  const extraTools: ToolSet | undefined = (() => {
    const next = { ...((executionInput.extraTools as ToolSet | undefined) ?? {}) } as ToolSet
    return Object.keys(next).length > 0 ? next : undefined
  })()

  return createAgentToolSet(toolContext, {
    availableSkills,
    fetchImpl: deps.webExternalFetchImpl ?? deps.fetchImpl,
    loadBrowserSnapshot: deps.loadBrowserSnapshot,
    browserAutomationService: deps.browserAutomationService,
    searchService: deps.searchService,
    memoryService: resolveToolMemoryService(input),
    webSearchService: deps.webSearchService,
    updateProfileDeps: {
      userDocumentPath: isGuest ? resolveYachiyoUserPath(workspacePath) : resolveYachiyoUserPath(),
      ...(isExternalChannel
        ? { userDocumentMode: isGuest ? ('guest' as const) : ('owner' as const) }
        : {})
    },
    ...(!executionInput.thread.privacyMode &&
    (!isExternalChannel || isOwnerDm) &&
    deps.memoryService.isConfigured()
      ? {
          rememberDeps: {
            memoryService: deps.memoryService,
            workspacePath,
            threadId: executionInput.thread.id
          }
        }
      : {}),
    ...(!executionInput.thread.privacyMode && (!isExternalChannel || isOwnerDm)
      ? {
          activityOcrEnabled:
            input.preparedContext.config.general?.activityTracking?.ocr?.enabled === true,
          sourceQueryExecutor: deps.sourceQueryExecutor,
          sourceQueryStorage: deps.storage
        }
      : {}),
    ...(isLocalRunTrigger ? { askUserContext: createAskUserContext(input) } : {}),
    ...(isLocalRunTrigger ? { todoContext: createTodoContext(input) } : {}),
    ...(deps.sentinelContext ? { sentinelContext: deps.sentinelContext } : {}),
    ...(canUseDelegateTask
      ? {
          subagentProfiles: enabledSubagentProfiles,
          subagentsConfig,
          availableWorkspaces: subagentAvailableWorkspaces,
          settings: deps.readSettings(),
          createModelRuntime: deps.createModelRuntime,
          onSubagentProgress: (event: DelegateTaskProgressEvent) => {
            input.markProgress()
            deps.onSubagentProgress?.(event)
          },
          onSubagentStarted: (event: DelegateTaskStartedEvent) => {
            handleSubagentStarted(input, event)
          },
          onSubagentFinished: (event: DelegateTaskFinishedEvent) => {
            handleSubagentFinished(input, event)
          },
          onSubagentToolCall: (event: DelegateTaskToolCallEvent) => {
            handleSubagentToolCall(input, event)
          }
        }
      : {}),
    planModeExitEnabled: Boolean(planModeDocument),
    ...(extraTools ? { extraTools } : {})
  })
}

function createTodoContext(input: CreateRunToolSetInput): {
  getCurrentItems: () => readonly TodoItemRecord[]
  createId: () => string
  onUpdate: (items: TodoItemRecord[]) => void
} {
  return {
    getCurrentItems: () => input.deps.getTodoItems?.() ?? [],
    createId: input.deps.createId,
    onUpdate: (items) => {
      const step = input.advanceAgentStep({ notifyTodoReminder: false })
      input.deps.onTodoListUpdated?.({
        items,
        step
      })
    }
  }
}

function resolveToolMemoryService(
  input: CreateRunToolSetInput
): RunExecutionDeps['memoryService'] | undefined {
  const { deps, executionInput, preparedContext } = input
  if (executionInput.thread.privacyMode) {
    return undefined
  }
  if (preparedContext.isGuest) {
    return createFilteredMemoryService(
      deps.memoryService,
      readChannelsConfig().memoryFilterKeywords ?? []
    )
  }
  return deps.memoryService
}

function createAskUserContext(input: CreateRunToolSetInput): {
  waitForUserAnswer: (toolCallId: string, question: string, choices?: string[]) => Promise<string>
} {
  return {
    waitForUserAnswer: (
      toolCallId: string,
      question: string,
      choices?: string[]
    ): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
        input.pendingUserAnswers.set(toolCallId, { resolve, reject })
        input.setExecutionPhase('waiting-for-user')
        const existingToolCall = input.toolLifecycle.getToolCall(toolCallId)
        const waitingToolCall: ToolCallRecord = {
          ...(existingToolCall ?? {
            id: toolCallId,
            runId: input.executionInput.runId,
            threadId: input.executionInput.thread.id,
            requestMessageId: input.executionInput.requestMessageId,
            toolName: 'askUser',
            startedAt: input.deps.timestamp(),
            stepIndex: input.toolLifecycle.getStepCount(),
            stepBudget: input.maxToolSteps
          }),
          status: 'waiting-for-user',
          inputSummary: question.slice(0, 160),
          details: { kind: 'askUser' as const, question, choices }
        } as ToolCallRecord

        input.toolLifecycle.setToolCall(waitingToolCall)
        if (existingToolCall) {
          input.updateToolCall(waitingToolCall)
        } else {
          input.createToolCall(waitingToolCall)
        }
        input.persistRecoveryCheckpoint()

        input.deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.executionInput.thread.id,
          runId: input.executionInput.runId,
          toolCall: waitingToolCall
        })
        input.deps.emit<NotificationRequestEvent>({
          type: 'notification.requested',
          ...createRunEventMetadata({
            threadId: input.executionInput.thread.id,
            runId: input.executionInput.runId,
            runTrigger: input.executionInput.runTrigger
          }),
          title: 'Yachiyo needs your input',
          body: question.slice(0, 100)
        })
      })
    }
  }
}

function handleSubagentStarted(
  input: CreateRunToolSetInput,
  event: DelegateTaskStartedEvent
): void {
  input.markProgress()
  const startedAt = event.startedAt ?? input.deps.timestamp()
  input.subagentStartedAtByDelegationId.set(event.delegationId, startedAt)
  input.deps.emit<SubagentStartedEvent>({
    type: 'subagent.started',
    ...createRunEventMetadata({
      threadId: input.executionInput.thread.id,
      runId: input.executionInput.runId,
      runTrigger: input.executionInput.runTrigger
    }),
    delegationId: event.delegationId,
    agentName: event.agentName,
    agentType: event.agentType,
    workspacePath: event.workspacePath,
    startedAt,
    prompt: event.prompt,
    codeName: event.codeName
  })
}

function handleSubagentFinished(
  input: CreateRunToolSetInput,
  event: DelegateTaskFinishedEvent
): void {
  input.markProgress()
  if (event.sessionId) {
    persistLatestDelegatedSession(input, event, event.sessionId)
  }
  input.deps.emit<SubagentFinishedEvent>({
    type: 'subagent.finished',
    ...createRunEventMetadata({
      threadId: input.executionInput.thread.id,
      runId: input.executionInput.runId,
      runTrigger: input.executionInput.runTrigger
    }),
    delegationId: event.delegationId,
    agentName: event.agentName,
    agentType: event.agentType,
    status: event.status,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.lastMessage ? { lastMessage: event.lastMessage } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}),
    ...(event.completionTokens !== undefined ? { completionTokens: event.completionTokens } : {}),
    ...(event.codeName ? { codeName: event.codeName } : {})
  })
}

function handleSubagentToolCall(
  input: CreateRunToolSetInput,
  event: DelegateTaskToolCallEvent
): void {
  input.markProgress()
  input.deps.emit<SubagentToolCallEvent>({
    type: 'subagent.toolCall',
    ...createRunEventMetadata({
      threadId: input.executionInput.thread.id,
      runId: input.executionInput.runId,
      runTrigger: input.executionInput.runTrigger
    }),
    delegationId: event.delegationId,
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    toolName: event.toolName,
    inputSummary: event.inputSummary,
    ...(event.outputSummary ? { outputSummary: event.outputSummary } : {}),
    ...(event.status ? { status: event.status } : {})
  })
}

function persistLatestDelegatedSession(
  input: CreateRunToolSetInput,
  event: DelegateTaskFinishedEvent,
  sessionId: string
): void {
  const delegationStartedAt =
    input.subagentStartedAtByDelegationId.get(event.delegationId) ?? input.deps.timestamp()
  const currentThread = input.deps.readThread(input.executionInput.thread.id)
  const existingSession = currentThread.lastDelegatedSession
  if (existingSession && existingSession.timestamp.localeCompare(delegationStartedAt) > 0) {
    return
  }

  const updatedThread: ThreadRecord = {
    ...currentThread,
    lastDelegatedSession: {
      agentName: event.agentName,
      sessionId,
      workspacePath: event.workspacePath,
      timestamp: delegationStartedAt
    }
  }
  input.deps.storage.updateThread(updatedThread)
  input.deps.emit<ThreadUpdatedEvent>({
    type: 'thread.updated',
    threadId: input.executionInput.thread.id,
    thread: updatedThread
  })
}
