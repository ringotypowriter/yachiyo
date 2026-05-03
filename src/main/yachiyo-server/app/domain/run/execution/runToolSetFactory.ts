import type { ToolSet } from 'ai'

import type {
  NotificationRequestEvent,
  SubagentFinishedEvent,
  SubagentStartedEvent,
  ThreadRecord,
  ThreadUpdatedEvent,
  ToolCallRecord,
  ToolCallUpdatedEvent
} from '../../../../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoUserPath } from '../../../../config/paths.ts'
import { readChannelsConfig } from '../../../../runtime/channelsConfig.ts'
import type { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import { createFilteredMemoryService } from '../../../../services/memory/memoryService.ts'
import { createAgentToolSet } from '../../../../tools/agentTools.ts'
import type {
  DelegateCodingTaskFinishedEvent,
  DelegateCodingTaskProgressEvent,
  DelegateCodingTaskStartedEvent
} from '../../../../tools/agentTools.ts'
import type { PreparedServerRunContext } from '../context/prepareServerRunContext.ts'
import type { ExecuteRunInput, RunExecutionDeps } from './runExecutionTypes.ts'

type ExecutionPhase = 'generating' | 'tool-running' | 'waiting-for-user'

interface PendingUserAnswer {
  resolve: (answer: string) => void
  reject: (err: Error) => void
}

export interface CreateRunToolSetInput {
  createToolCall: (toolCall: ToolCallRecord) => void
  deps: RunExecutionDeps
  executionInput: ExecuteRunInput
  getStepCount: () => number
  markProgress: () => void
  maxToolSteps: number
  pendingUserAnswers: Map<string, PendingUserAnswer>
  persistRecoveryCheckpoint: () => void
  preparedContext: PreparedServerRunContext
  setExecutionPhase: (phase: ExecutionPhase) => void
  snapshotTracker: SnapshotTracker
  subagentStartedAtByDelegationId: Map<string, string>
  toolCalls: Map<string, ToolCallRecord>
  updateToolCall: (toolCall: ToolCallRecord) => void
}

export function createRunToolSet(input: CreateRunToolSetInput): ToolSet | undefined {
  const {
    availableSkills,
    enabledSubagentProfiles,
    gitCtx,
    gitValidatedWorkspaces,
    isExternalChannel,
    isGuest,
    isOwnerDm,
    modelEnabledTools,
    workspacePath
  } = input.preparedContext
  const deps = input.deps
  const executionInput = input.executionInput

  return createAgentToolSet(
    {
      enabledTools: modelEnabledTools,
      workspacePath,
      sandboxed: isExternalChannel && !isOwnerDm,
      snapshotTracker: input.snapshotTracker,
      readRecordCache: executionInput.readRecordCache,
      imageToTextService: deps.imageToTextService,
      isModelImageCapable: deps.isModelImageCapable,
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
    },
    {
      availableSkills,
      fetchImpl: deps.webExternalFetchImpl ?? deps.fetchImpl,
      loadBrowserSnapshot: deps.loadBrowserSnapshot,
      searchService: deps.searchService,
      memoryService: resolveToolMemoryService(input),
      webSearchService: deps.webSearchService,
      updateProfileDeps: {
        userDocumentPath: isGuest
          ? resolveYachiyoUserPath(workspacePath)
          : resolveYachiyoUserPath(),
        ...(isExternalChannel
          ? { userDocumentMode: isGuest ? ('guest' as const) : ('owner' as const) }
          : {})
      },
      ...(!executionInput.thread.privacyMode &&
      (!isExternalChannel || isOwnerDm) &&
      deps.memoryService.isConfigured()
        ? { rememberDeps: { memoryService: deps.memoryService } }
        : {}),
      ...(!executionInput.thread.privacyMode && (!isExternalChannel || isOwnerDm)
        ? {
            crossThreadSearch: (searchInput: {
              query: string
              limit?: number
              includePrivate?: boolean
            }) => deps.storage.searchThreadsAndMessagesFts(searchInput)
          }
        : {}),
      ...(!isExternalChannel ? { askUserContext: createAskUserContext(input) } : {}),
      ...((gitCtx.hasGit || gitValidatedWorkspaces.length > 0) && enabledSubagentProfiles.length > 0
        ? {
            subagentProfiles: enabledSubagentProfiles,
            availableWorkspaces: gitValidatedWorkspaces,
            onSubagentProgress: (event: DelegateCodingTaskProgressEvent) => {
              input.markProgress()
              deps.onSubagentProgress?.(event)
            },
            onSubagentStarted: (event: DelegateCodingTaskStartedEvent) => {
              handleSubagentStarted(input, event)
            },
            onSubagentFinished: (event: DelegateCodingTaskFinishedEvent) => {
              handleSubagentFinished(input, event)
            }
          }
        : {}),
      ...(executionInput.extraTools ? { extraTools: executionInput.extraTools } : {})
    }
  )
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
        const existingToolCall = input.toolCalls.get(toolCallId)
        const waitingToolCall: ToolCallRecord = {
          ...(existingToolCall ?? {
            id: toolCallId,
            runId: input.executionInput.runId,
            threadId: input.executionInput.thread.id,
            requestMessageId: input.executionInput.requestMessageId,
            toolName: 'askUser',
            startedAt: input.deps.timestamp(),
            stepIndex: input.getStepCount(),
            stepBudget: input.maxToolSteps
          }),
          status: 'waiting-for-user',
          inputSummary: question.slice(0, 160),
          details: { kind: 'askUser' as const, question, choices }
        } as ToolCallRecord

        input.toolCalls.set(toolCallId, waitingToolCall)
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
          threadId: input.executionInput.thread.id,
          runId: input.executionInput.runId,
          title: 'Yachiyo needs your input',
          body: question.slice(0, 100)
        })
      })
    }
  }
}

function handleSubagentStarted(
  input: CreateRunToolSetInput,
  event: DelegateCodingTaskStartedEvent
): void {
  input.markProgress()
  input.subagentStartedAtByDelegationId.set(event.delegationId, input.deps.timestamp())
  input.deps.emit<SubagentStartedEvent>({
    type: 'subagent.started',
    threadId: input.executionInput.thread.id,
    runId: input.executionInput.runId,
    delegationId: event.delegationId,
    agentName: event.agentName,
    workspacePath: event.workspacePath
  })
}

function handleSubagentFinished(
  input: CreateRunToolSetInput,
  event: DelegateCodingTaskFinishedEvent
): void {
  input.markProgress()
  if (event.sessionId) {
    persistLatestDelegatedSession(input, event, event.sessionId)
  }
  input.deps.emit<SubagentFinishedEvent>({
    type: 'subagent.finished',
    threadId: input.executionInput.thread.id,
    runId: input.executionInput.runId,
    delegationId: event.delegationId,
    agentName: event.agentName,
    status: event.status,
    ...(event.sessionId ? { sessionId: event.sessionId } : {})
  })
}

function persistLatestDelegatedSession(
  input: CreateRunToolSetInput,
  event: DelegateCodingTaskFinishedEvent,
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
