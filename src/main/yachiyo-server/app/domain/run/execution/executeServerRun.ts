import { stepCountIs, type StopCondition, type ToolSet } from 'ai'
import { performance } from 'node:perf_hooks'

import { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import { runGc } from '../../../../services/fileSnapshot/snapshotGc.ts'

import type {
  HarnessFinishedEvent,
  HarnessStartedEvent,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageReasoningDeltaEvent,
  MessageRecord,
  MessageStartedEvent,
  MessageTextBlockRecord,
  NotificationRequestEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunRetryingEvent,
  RunUsageUpdatedEvent,
  SubagentStartedEvent,
  SubagentFinishedEvent,
  ThreadRecord,
  ThreadUpdatedEvent,
  SnapshotReadyEvent,
  ToolCallRecord,
  ToolCallUpdatedEvent
} from '../../../../../../shared/yachiyo/protocol.ts'
import { isTrackedToolName } from '../../../../../../shared/yachiyo/protocol.ts'
import { wouldCreateParentCycle } from '../../../../../../shared/yachiyo/threadTree.ts'
import { createRunPerfCollector } from '../../../../services/perfMonitor.ts'
import { resolveYachiyoUserPath } from '../../../../config/paths.ts'
import { readChannelsConfig } from '../../../../runtime/channelsConfig.ts'
import type { ModelUsage } from '../../../../runtime/types.ts'
import { RETRY_MAX_ATTEMPTS } from '../../../../runtime/modelRuntime.ts'
import { isRetryableRunError, RetryableRunError } from '../../../../runtime/runtimeErrors.ts'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import {
  createAgentToolSet,
  type DelegateCodingTaskFinishedEvent,
  type DelegateCodingTaskProgressEvent,
  type DelegateCodingTaskStartedEvent,
  normalizeToolResult,
  summarizeToolInput
} from '../../../../tools/agentTools.ts'
import { createFilteredMemoryService } from '../../../../services/memory/memoryService.ts'
import { createDeltaBatcher, DEFAULT_HARNESS_NAME } from '../../shared.ts'
import {
  appendRecoveryReasoningDelta,
  appendRecoveryTextDelta,
  appendRecoveryToolCall,
  appendRecoveryToolResult,
  balanceRecoveryResponseMessages,
  buildRecoveryResponseMessages,
  cloneRecoveryResponseMessages,
  type RecoveryResponseMessage
} from '../../runRecovery.ts'
import { prepareServerRunContext } from '../context/prepareServerRunContext.ts'
import { balanceResponseMessages } from '../context/runHistory.ts'
import { mergeRunUsage } from './runUsage.ts'
import { appendMessageDeltaToTextBlocks } from './textBlocks.ts'
import {
  getCompletedBackgroundBashError,
  getCompletedBackgroundBashOutputSummary,
  getCompletedBackgroundBashStatus,
  mergeBackgroundBashDetails,
  resolveCompletedBackgroundBashTask
} from '../tools/backgroundBashToolResult.ts'
import {
  bindCompletedToolCallsToAssistant,
  finishPendingToolCalls,
  restorePersistedRunToolCalls
} from '../tools/toolCallLifecycle.ts'
import { upsertRunRecoveryCheckpoint } from './recoveryCheckpoint.ts'
import { consumeDuplicatePrefix } from './streamDedup.ts'
import { persistTerminalAssistantMessage } from './terminalPersistence.ts'
import type {
  CancelWithSteerReason,
  ExecuteRunInput,
  ExecuteRunResult,
  RestartRunReason,
  RunExecutionDeps
} from './runExecutionTypes.ts'

function isRestartRunReason(value: unknown): value is RestartRunReason {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'restart' &&
    typeof (value as { nextRequestMessageId?: unknown }).nextRequestMessageId === 'string'
  )
}

function isCancelWithSteerReason(value: unknown): value is CancelWithSteerReason {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'cancel-with-steer' &&
    (value as { steerInput?: unknown }).steerInput != null
  )
}

const FRIENDLY_ERROR_LABELS: Array<[test: RegExp | string, label: string]> = [
  ['ERR_HTTP2_PROTOCOL_ERROR', 'Connection interrupted (HTTP/2 stream reset)'],
  ['ECONNRESET', 'Connection reset by server'],
  ['ETIMEDOUT', 'Connection timed out'],
  ['ECONNREFUSED', 'Connection refused'],
  ['ENOTFOUND', 'Could not resolve host'],
  ['ENETDOWN', 'Network is down'],
  ['ENETUNREACH', 'Network is unreachable'],
  ['ENETRESET', 'Network connection reset'],
  ['EHOSTUNREACH', 'Host is unreachable'],
  ['ERR_CONNECTION_CLOSED', 'Connection closed unexpectedly'],
  ['ERR_NETWORK_CHANGED', 'Network changed during request'],
  ['ERR_INTERNET_DISCONNECTED', 'Internet connection lost'],
  ['UND_ERR_SOCKET', 'Socket error'],
  ['UND_ERR_CONNECT_TIMEOUT', 'Connection timed out'],
  [/socket hang up/i, 'Connection dropped (socket hang up)'],
  [/fetch failed/i, 'Network request failed']
]

function humanizeErrorMessage(raw: string): string {
  for (const [test, label] of FRIENDLY_ERROR_LABELS) {
    if (typeof test === 'string' ? raw.includes(test) : test.test(raw)) return label
  }
  if (/^HTTP (\d{3})$/.test(raw)) return `Server error (${raw})`
  return raw
}

function extractRetryErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return humanizeErrorMessage(String(error))
  const code = (error as { code?: string }).code
  if (code) {
    const label = humanizeErrorMessage(code)
    if (label !== code) return label
  }
  if (error.message) return humanizeErrorMessage(error.message)
  const statusCode = (error as { statusCode?: number }).statusCode
  return statusCode ? humanizeErrorMessage(`HTTP ${statusCode}`) : 'Provider error'
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return
  }

  const error = new Error('Aborted')
  error.name = 'AbortError'
  throw error
}

export async function executeServerRun(
  deps: RunExecutionDeps,
  input: ExecuteRunInput
): Promise<ExecuteRunResult> {
  const perfCollector = createRunPerfCollector(input.runId)
  const instrumentedCreateToolCall = (toolCall: ToolCallRecord): void => {
    const t0 = performance.now()
    deps.storage.createToolCall(toolCall)
    perfCollector.recordToolCallWrite(performance.now() - t0)
  }
  const instrumentedUpdateToolCall = (toolCall: ToolCallRecord): void => {
    const t0 = performance.now()
    deps.storage.updateToolCall(toolCall)
    perfCollector.recordToolCallWrite(performance.now() - t0)
  }
  const settings = deps.readSettings()
  const harnessId = deps.createId()
  const recoveryCheckpoint = input.recoveryCheckpoint
  const messageId = recoveryCheckpoint?.assistantMessageId ?? deps.createId()
  const toolCalls = recoveryCheckpoint
    ? restorePersistedRunToolCalls(deps.loadThreadToolCalls, input.thread.id, input.runId)
    : new Map<string, ToolCallRecord>()
  const subagentStartedAtByDelegationId = new Map<string, string>()
  const runningToolCallIds = new Set<string>()
  let stepCount = Math.max(0, ...[...toolCalls.values()].map((toolCall) => toolCall.stepIndex ?? 0))

  // Tool-fail loop guard: if the model repeats the same invalid tool input
  // multiple times, inject a system steer to break the cycle instead of
  // burning the entire step budget.
  const TOOL_FAIL_LOOP_WINDOW = 10
  const TOOL_FAIL_LOOP_THRESHOLD = 3
  const MAX_TOOL_FAIL_STEERS = 2
  const recentToolErrorKeys: string[] = []
  const seenFailedToolCallIds = new Set<string>()
  let toolFailLoopSteersInjected = input.priorToolFailLoopSteers ?? 0
  let lastLoopActionKey: string | undefined

  const bufferParts: string[] = recoveryCheckpoint?.content ? [recoveryCheckpoint.content] : []
  let bufferLength = bufferParts.reduce((sum, part) => sum + part.length, 0)
  const reasoningParts: string[] = recoveryCheckpoint?.reasoning
    ? [recoveryCheckpoint.reasoning]
    : []
  let reasoningLength = reasoningParts.reduce((sum, part) => sum + part.length, 0)
  let textBlocks: MessageTextBlockRecord[] = recoveryCheckpoint?.textBlocks
    ? [...recoveryCheckpoint.textBlocks]
    : []
  let shouldStartNewTextBlock = textBlocks.length === 0
  let executionPhase: 'generating' | 'tool-running' | 'waiting-for-user' = 'generating'
  const markProgress = (): void => {
    // No-op retained for call sites; the inactivity watchdog that consumed
    // this signal has been removed.
  }

  // Deferred promises for askUser tool calls waiting on user input
  const pendingUserAnswers = new Map<
    string,
    { resolve: (answer: string) => void; reject: (err: Error) => void }
  >()

  // Register the answer handler so the caller (RunDomain) can forward user answers.
  deps.onAskUserHandlerReady?.((toolCallId: string, answer: string): void => {
    const pending = pendingUserAnswers.get(toolCallId)
    if (pending) {
      pendingUserAnswers.delete(toolCallId)
      pending.resolve(answer)
    }
  })

  // When the run is aborted, immediately reject pending askUser promises so the
  // tool execution unblocks and the stream can exit. Without this the stream is
  // deadlocked: abort fires but the tool's deferred promise never settles.
  const rejectPendingUserAnswers = (): void => {
    for (const [id, pending] of pendingUserAnswers) {
      pending.reject(new Error('Run cancelled'))
      pendingUserAnswers.delete(id)
    }
  }
  input.abortController.signal.addEventListener('abort', rejectPendingUserAnswers, { once: true })

  let duplicateTextPrefix = recoveryCheckpoint?.content ?? ''
  let pendingDuplicateText = ''
  const recoveryCreatedAt = recoveryCheckpoint?.createdAt ?? deps.timestamp()
  let recoveryResponseMessages: RecoveryResponseMessage[] =
    (buildRecoveryResponseMessages({
      checkpoint: recoveryCheckpoint ?? { content: bufferParts.join('') },
      toolCalls: [...toolCalls.values()]
    }) as RecoveryResponseMessage[] | undefined) ?? []

  const persistRecoveryCheckpoint = (
    options: {
      lastError?: string
      recoveryAttempts?: number
    } = {}
  ): RunRecoveryCheckpoint | undefined => {
    if (!input.requestMessageId) {
      return undefined
    }

    const checkpoint: RunRecoveryCheckpoint = {
      runId: input.runId,
      threadId: input.thread.id,
      requestMessageId: input.requestMessageId,
      assistantMessageId: messageId,
      content: bufferParts.join(''),
      ...(textBlocks.length > 0 ? { textBlocks } : {}),
      ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
      ...(recoveryResponseMessages.length > 0
        ? { responseMessages: recoveryResponseMessages }
        : {}),
      enabledTools: [...input.enabledTools],
      ...(input.enabledSkillNames ? { enabledSkillNames: [...input.enabledSkillNames] } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.channelHint ? { channelHint: input.channelHint } : {}),
      updateHeadOnComplete: input.updateHeadOnComplete,
      createdAt: recoveryCreatedAt,
      updatedAt: deps.timestamp(),
      recoveryAttempts: options.recoveryAttempts ?? recoveryCheckpoint?.recoveryAttempts ?? 0,
      ...(options.lastError ? { lastError: options.lastError } : {})
    }
    const cpStart = performance.now()
    upsertRunRecoveryCheckpoint(deps, checkpoint)
    perfCollector.recordCheckpointWrite(performance.now() - cpStart)
    lastCheckpointPersistAtMs = Date.now()
    return checkpoint
  }

  // Coalesce per-delta checkpoint writes. better-sqlite3 is synchronous and
  // JSON.stringify over the growing buffer is O(n), so persisting on every
  // token stalls the main process run loop and triggers macOS ANR on long
  // streams. Tool-boundary call sites still use the immediate variant above.
  let lastCheckpointPersistAtMs = 0
  const streamStartedAtMs = Date.now()
  const RECOVERY_CHECKPOINT_BASE_INTERVAL_MS = 750
  const persistRecoveryCheckpointThrottled = (): void => {
    const elapsedMs = Date.now() - streamStartedAtMs
    let minInterval = RECOVERY_CHECKPOINT_BASE_INTERVAL_MS
    if (elapsedMs > 45000) {
      minInterval = 3000
    } else if (elapsedMs > 15000) {
      minInterval = 1500
    }
    if (Date.now() - lastCheckpointPersistAtMs < minInterval) {
      return
    }
    persistRecoveryCheckpoint()
  }

  const DELTA_FLUSH_INTERVAL_MS = 20

  const textDeltaBatcher = createDeltaBatcher({
    intervalMs: DELTA_FLUSH_INTERVAL_MS,
    onFlush: (batch) => {
      bufferParts.push(batch)
      bufferLength += batch.length
      appendRecoveryTextDelta(recoveryResponseMessages, batch)
      const nextTextBlockState = appendMessageDeltaToTextBlocks({
        textBlocks,
        delta: batch,
        timestamp: deps.timestamp(),
        createId: deps.createId,
        shouldStartNewBlock: shouldStartNewTextBlock
      })
      textBlocks = nextTextBlockState.textBlocks
      shouldStartNewTextBlock = nextTextBlockState.shouldStartNewBlock
      persistRecoveryCheckpointThrottled()
      perfCollector.recordDeltaEvent()
      perfCollector.addTextChars(batch.length)
      deps.emit<MessageDeltaEvent>({
        type: 'message.delta',
        threadId: input.thread.id,
        runId: input.runId,
        messageId,
        delta: batch
      })
    },
    isAborted: () => input.abortController.signal.aborted
  })

  const reasoningDeltaBatcher = createDeltaBatcher({
    intervalMs: DELTA_FLUSH_INTERVAL_MS,
    onFlush: (batch) => {
      reasoningParts.push(batch)
      reasoningLength += batch.length
      appendRecoveryReasoningDelta(recoveryResponseMessages, batch)
      persistRecoveryCheckpointThrottled()
      perfCollector.recordReasoningDeltaEvent()
      deps.emit<MessageReasoningDeltaEvent>({
        type: 'message.reasoning.delta',
        threadId: input.thread.id,
        runId: input.runId,
        messageId,
        delta: batch
      })
    },
    isAborted: () => input.abortController.signal.aborted
  })

  const setExecutionPhase = (phase: 'generating' | 'tool-running' | 'waiting-for-user'): void => {
    if (executionPhase === phase) {
      return
    }

    executionPhase = phase
    deps.onExecutionPhaseChange?.(phase)
  }

  deps.emit<HarnessStartedEvent>({
    type: 'harness.started',
    threadId: input.thread.id,
    runId: input.runId,
    harnessId,
    name: DEFAULT_HARNESS_NAME
  })
  if (!recoveryCheckpoint) {
    deps.emit<MessageStartedEvent>({
      type: 'message.started',
      threadId: input.thread.id,
      runId: input.runId,
      messageId,
      parentMessageId: input.requestMessageId
    })
  }
  persistRecoveryCheckpoint()

  let snapshotTracker: SnapshotTracker | null = input.snapshotTracker ?? null
  /** Tracks the most recent usage from the model stream; hoisted so catch blocks can persist it. */
  let lastUsage: ModelUsage | undefined
  let cumulativeCompletionTokens = input.priorUsage?.totalCompletionTokens ?? 0
  let tools: ToolSet | undefined

  try {
    const preparedContext = await prepareServerRunContext(deps, {
      runId: input.runId,
      thread: input.thread,
      requestMessageId: input.requestMessageId,
      enabledTools: input.enabledTools,
      ...(input.enabledSkillNames !== undefined
        ? { enabledSkillNames: input.enabledSkillNames }
        : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.channelHint ? { channelHint: input.channelHint } : {}),
      abortController: input.abortController,
      ...(input.recoveryCheckpoint ? { recoveryCheckpoint: input.recoveryCheckpoint } : {}),
      ...(input.isSteerLeg !== undefined ? { isSteerLeg: input.isSteerLeg } : {}),
      ...(input.priorUsage ? { priorUsage: input.priorUsage } : {}),
      ...(input.maxToolStepsOverride !== undefined
        ? { maxToolStepsOverride: input.maxToolStepsOverride }
        : {})
    })
    const {
      workspacePath,
      messages: finalMessages,
      modelEnabledTools,
      maxToolSteps,
      availableSkills,
      isExternalChannel,
      isGuest,
      isOwnerDm,
      enabledSubagentProfiles,
      gitCtx,
      gitValidatedWorkspaces
    } = preparedContext
    if (!snapshotTracker) {
      snapshotTracker = new SnapshotTracker(workspacePath, input.runId, input.thread.id)
      snapshotTracker.startBaselineScan()
    }
    const runtime = deps.createModelRuntime()
    tools = createAgentToolSet(
      {
        enabledTools: modelEnabledTools,
        workspacePath,
        sandboxed: isExternalChannel && !isOwnerDm,
        snapshotTracker,
        readRecordCache: input.readRecordCache,
        imageToTextService: deps.imageToTextService,
        isModelImageCapable: deps.isModelImageCapable,
        ...(deps.onBackgroundBashStarted
          ? {
              onBackgroundBashStarted: async (task) => {
                await deps.onBackgroundBashStarted?.({ ...task, threadId: input.thread.id })
              }
            }
          : {}),
        ...(deps.onBackgroundBashAdopted
          ? {
              onBackgroundBashAdopted: async (task) => {
                await deps.onBackgroundBashAdopted?.({ ...task, threadId: input.thread.id })
              }
            }
          : {})
      },
      {
        availableSkills,
        fetchImpl: deps.webExternalFetchImpl ?? deps.fetchImpl,
        loadBrowserSnapshot: deps.loadBrowserSnapshot,
        searchService: deps.searchService,
        memoryService: input.thread.privacyMode
          ? undefined
          : isGuest
            ? createFilteredMemoryService(
                deps.memoryService,
                readChannelsConfig().memoryFilterKeywords ?? []
              )
            : deps.memoryService,
        webSearchService: deps.webSearchService,
        updateProfileDeps: {
          userDocumentPath: isGuest
            ? resolveYachiyoUserPath(workspacePath)
            : resolveYachiyoUserPath(),
          ...(isExternalChannel
            ? { userDocumentMode: isGuest ? ('guest' as const) : ('owner' as const) }
            : {})
        },
        ...(!input.thread.privacyMode &&
        (!isExternalChannel || isOwnerDm) &&
        deps.memoryService.isConfigured()
          ? { rememberDeps: { memoryService: deps.memoryService } }
          : {}),
        // Cross-thread FTS search: only for local + owner DM, never in privacy mode
        ...(!input.thread.privacyMode && (!isExternalChannel || isOwnerDm)
          ? {
              crossThreadSearch: (searchInput: {
                query: string
                limit?: number
                includePrivate?: boolean
              }) => deps.storage.searchThreadsAndMessagesFts(searchInput)
            }
          : {}),
        // askUser is only available for direct chat runs — not external channel runs
        ...(!isExternalChannel
          ? {
              askUserContext: {
                waitForUserAnswer: (
                  toolCallId: string,
                  question: string,
                  choices?: string[]
                ): Promise<string> => {
                  return new Promise<string>((resolve, reject) => {
                    pendingUserAnswers.set(toolCallId, { resolve, reject })
                    setExecutionPhase('waiting-for-user')

                    // Update the existing tool call record persisted by onToolCallStart
                    const existingToolCall = toolCalls.get(toolCallId)
                    const waitingToolCall: ToolCallRecord = {
                      ...(existingToolCall ?? {
                        id: toolCallId,
                        runId: input.runId,
                        threadId: input.thread.id,
                        requestMessageId: input.requestMessageId,
                        toolName: 'askUser',
                        startedAt: deps.timestamp(),
                        stepIndex: stepCount,
                        stepBudget: maxToolSteps
                      }),
                      status: 'waiting-for-user',
                      inputSummary: question.slice(0, 160),
                      details: { kind: 'askUser' as const, question, choices }
                    } as ToolCallRecord

                    toolCalls.set(toolCallId, waitingToolCall)
                    if (existingToolCall) {
                      instrumentedUpdateToolCall(waitingToolCall)
                    } else {
                      instrumentedCreateToolCall(waitingToolCall)
                    }
                    persistRecoveryCheckpoint()

                    deps.emit<ToolCallUpdatedEvent>({
                      type: 'tool.updated',
                      threadId: input.thread.id,
                      runId: input.runId,
                      toolCall: waitingToolCall
                    })
                    deps.emit<NotificationRequestEvent>({
                      type: 'notification.requested',
                      threadId: input.thread.id,
                      runId: input.runId,
                      title: 'Yachiyo needs your input',
                      body: question.slice(0, 100)
                    })
                  })
                }
              }
            }
          : {}),
        ...((gitCtx.hasGit || gitValidatedWorkspaces.length > 0) &&
        enabledSubagentProfiles.length > 0
          ? {
              subagentProfiles: enabledSubagentProfiles,
              availableWorkspaces: gitValidatedWorkspaces,
              onSubagentProgress: (event: DelegateCodingTaskProgressEvent) => {
                markProgress()
                deps.onSubagentProgress?.(event)
              },
              onSubagentStarted: (event: DelegateCodingTaskStartedEvent) => {
                markProgress()
                subagentStartedAtByDelegationId.set(event.delegationId, deps.timestamp())
                deps.emit<SubagentStartedEvent>({
                  type: 'subagent.started',
                  threadId: input.thread.id,
                  runId: input.runId,
                  delegationId: event.delegationId,
                  agentName: event.agentName,
                  workspacePath: event.workspacePath
                })
              },
              onSubagentFinished: (event: DelegateCodingTaskFinishedEvent) => {
                markProgress()
                if (event.sessionId) {
                  const delegationStartedAt =
                    subagentStartedAtByDelegationId.get(event.delegationId) ?? deps.timestamp()
                  const currentThread = deps.readThread(input.thread.id)
                  const existingSession = currentThread.lastDelegatedSession
                  if (
                    !existingSession ||
                    existingSession.timestamp.localeCompare(delegationStartedAt) <= 0
                  ) {
                    const updatedThread: ThreadRecord = {
                      ...currentThread,
                      lastDelegatedSession: {
                        agentName: event.agentName,
                        sessionId: event.sessionId,
                        workspacePath: event.workspacePath,
                        timestamp: delegationStartedAt
                      }
                    }
                    deps.storage.updateThread(updatedThread)
                    deps.emit<ThreadUpdatedEvent>({
                      type: 'thread.updated',
                      threadId: input.thread.id,
                      thread: updatedThread
                    })
                  }
                }
                deps.emit<SubagentFinishedEvent>({
                  type: 'subagent.finished',
                  threadId: input.thread.id,
                  runId: input.runId,
                  delegationId: event.delegationId,
                  agentName: event.agentName,
                  status: event.status,
                  ...(event.sessionId ? { sessionId: event.sessionId } : {})
                })
              }
            }
          : {}),
        ...(input.extraTools ? { extraTools: input.extraTools } : {})
      }
    )
    console.log(
      `[yachiyo][run] toolSet: ${tools ? Object.keys(tools).join(', ') : 'none'}, extraTools: ${input.extraTools ? Object.keys(input.extraTools).join(', ') : 'none'}`
    )
    deps.onEnabledToolsUsed(input.enabledTools)

    const hasPendingSteer = deps.hasPendingSteer
    const stopWhen: Array<StopCondition<ToolSet>> | undefined = tools
      ? [
          stepCountIs(maxToolSteps),
          ({ steps }) => {
            if (!hasPendingSteer?.()) {
              return false
            }

            return (steps.at(-1)?.toolResults.length ?? 0) > 0
          }
        ]
      : undefined

    const stream = runtime.streamReply({
      messages: finalMessages,
      settings,
      signal: input.abortController.signal,
      purpose: 'chat',
      promptCacheKey: input.thread.id,
      maxToolSteps,
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(tools ? { tools } : {}),
      ...(stopWhen ? { stopWhen } : {}),
      onStepUsage: (stepUsage) => {
        cumulativeCompletionTokens += stepUsage.completionTokens
        deps.emit<RunUsageUpdatedEvent>({
          type: 'run.usage.updated',
          threadId: input.thread.id,
          runId: input.runId,
          promptTokens: stepUsage.promptTokens,
          completionTokens: cumulativeCompletionTokens
        })
      },
      onFinish: (usage) => {
        markProgress()
        lastUsage = usage
      },
      onRetry: (attempt, maxAttempts, delayMs, error) => {
        markProgress()
        textDeltaBatcher.flush()
        reasoningDeltaBatcher.flush()
        const normalizedResponseMessages = buildRecoveryResponseMessages({
          checkpoint: {
            content: bufferParts.join(''),
            reasoning: reasoningParts.join(''),
            ...(recoveryResponseMessages.length > 0
              ? { responseMessages: recoveryResponseMessages }
              : {})
          },
          toolCalls: [...toolCalls.values()]
        }) as RecoveryResponseMessage[] | undefined
        recoveryResponseMessages =
          normalizedResponseMessages ??
          cloneRecoveryResponseMessages(recoveryCheckpoint?.responseMessages) ??
          []
        persistRecoveryCheckpoint()
        deps.emit<RunRetryingEvent>({
          type: 'run.retrying',
          threadId: input.thread.id,
          runId: input.runId,
          attempt,
          maxAttempts,
          delayMs,
          error: extractRetryErrorMessage(error)
        })
      },
      onReasoningDelta: (reasoningDelta) => {
        markProgress()
        reasoningDeltaBatcher.push(reasoningDelta)
      },
      onToolCallPreparing: (event) => {
        if (!isTrackedToolName(event.toolName)) {
          return
        }

        markProgress()
        textDeltaBatcher.flush()
        reasoningDeltaBatcher.flush()
        shouldStartNewTextBlock = true

        const toolCall: ToolCallRecord = {
          id: event.toolCallId,
          runId: input.runId,
          threadId: input.thread.id,
          requestMessageId: input.requestMessageId,
          toolName: event.toolName,
          status: 'preparing',
          inputSummary: '',
          startedAt: deps.timestamp(),
          stepIndex: stepCount + 1,
          stepBudget: maxToolSteps
        }

        toolCalls.set(toolCall.id, toolCall)
        instrumentedCreateToolCall(toolCall)
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })
      },
      onToolCallStart: (event) => {
        if (!isTrackedToolName(event.toolCall.toolName)) {
          return
        }

        markProgress()
        textDeltaBatcher.flush()
        reasoningDeltaBatcher.flush()
        runningToolCallIds.add(event.toolCall.toolCallId)
        shouldStartNewTextBlock = true
        setExecutionPhase('tool-running')
        stepCount++

        // Upgrade from 'preparing' if the early record exists, otherwise create fresh.
        // The preparing record may have been stored under a different key if
        // the fullStream's tool-input-start `part.id` diverged from the SDK's
        // canonical `toolCallId`. When the direct lookup misses, fall back to
        // the most recent preparing record for the same tool name and clean up
        // the stale key so the map stays consistent.
        let existing = toolCalls.get(event.toolCall.toolCallId)
        let orphanedPreparingKey: string | undefined
        if (!existing) {
          for (const [key, record] of toolCalls) {
            if (
              record.status === 'preparing' &&
              record.toolName === event.toolCall.toolName &&
              key !== event.toolCall.toolCallId
            ) {
              existing = record
              orphanedPreparingKey = key
              break
            }
          }
        }
        const upgradingFromPreparing = existing?.status === 'preparing'
        const toolCall: ToolCallRecord = {
          ...(existing ?? {}),
          id: event.toolCall.toolCallId,
          runId: input.runId,
          threadId: input.thread.id,
          requestMessageId: input.requestMessageId,
          toolName: event.toolCall.toolName,
          status: 'running',
          inputSummary: summarizeToolInput(event.toolCall.toolName, event.toolCall.input),
          startedAt: existing?.startedAt ?? deps.timestamp(),
          stepIndex: stepCount,
          stepBudget: maxToolSteps
        }

        // Remove the orphaned preparing entry from the in-memory map so it
        // doesn't linger or get bound to the assistant message with a stale ID.
        // The storage record will be superseded by the create/update below.
        if (orphanedPreparingKey) {
          toolCalls.delete(orphanedPreparingKey)
        }

        toolCalls.set(toolCall.id, toolCall)
        if (upgradingFromPreparing && !orphanedPreparingKey) {
          // Normal upgrade: same key, record exists in storage.
          instrumentedUpdateToolCall(toolCall)
        } else {
          // Either fresh record or the ID changed (orphan remap) — the old
          // storage row is keyed by the stale ID so update would be a no-op.
          // Always create a new row under the canonical ID.
          instrumentedCreateToolCall(toolCall)
        }
        appendRecoveryToolCall(recoveryResponseMessages, {
          toolCallId: toolCall.id,
          toolName: toolCall.toolName,
          toolInput: event.toolCall.input
        })
        persistRecoveryCheckpoint()
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })
      },
      onToolCallUpdate: (event) => {
        if (!isTrackedToolName(event.toolCall.toolName)) {
          return
        }

        const startedToolCall = toolCalls.get(event.toolCall.toolCallId)
        if (!startedToolCall) {
          return
        }

        if (startedToolCall.status !== 'running') {
          return
        }

        markProgress()
        const normalized = normalizeToolResult(event.toolCall.toolName, event.output, {
          phase: 'update'
        })
        const toolCall: ToolCallRecord = {
          ...startedToolCall,
          status: 'running',
          ...(normalized.outputSummary ? { outputSummary: normalized.outputSummary } : {}),
          ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
          ...(normalized.details ? { details: normalized.details } : {})
        }

        toolCalls.set(toolCall.id, toolCall)
        instrumentedUpdateToolCall(toolCall)
        persistRecoveryCheckpoint()
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })
      },
      onToolCallError: (event) => {
        // Tool-fail loop guard: deduplicate by toolCallId and track recent errors.
        if (!seenFailedToolCallIds.has(event.toolCall.toolCallId)) {
          seenFailedToolCallIds.add(event.toolCall.toolCallId)
          const errorMessage =
            event.error instanceof Error ? event.error.message : String(event.error)
          const inputJson = JSON.stringify(event.toolCall.input)
          const key = `${event.toolCall.toolName}:${errorMessage}:${inputJson}`
          recentToolErrorKeys.push(key)
          if (recentToolErrorKeys.length > TOOL_FAIL_LOOP_WINDOW) {
            recentToolErrorKeys.shift()
          }
          const count = recentToolErrorKeys.filter((k) => k === key).length
          if (count >= TOOL_FAIL_LOOP_THRESHOLD && key !== lastLoopActionKey) {
            lastLoopActionKey = key
            if (toolFailLoopSteersInjected >= MAX_TOOL_FAIL_STEERS) {
              throw new Error(
                `Tool fail loop melt-out: the model repeatedly called '${event.toolCall.toolName}' ` +
                  `with the same invalid input after ${MAX_TOOL_FAIL_STEERS} steering attempts. Stopping the run.`
              )
            }
            toolFailLoopSteersInjected++
            deps.injectPendingSteer?.({
              content:
                `You appear to be stuck in a loop sending the same invalid '${event.toolCall.toolName}' tool input ` +
                `(${count} consecutive failures). Please stop and reconsider your approach. ` +
                `Analyze the validation error, fix your input, or try a different tool.`
            })
          }
        }

        if (!isTrackedToolName(event.toolCall.toolName)) {
          return 'continue'
        }

        markProgress()
        textDeltaBatcher.flush()
        reasoningDeltaBatcher.flush()
        setExecutionPhase('tool-running')
        stepCount++

        const finishedAt = deps.timestamp()
        const errorMessage =
          event.error instanceof Error ? event.error.message : String(event.error)
        const existingToolCall = toolCalls.get(event.toolCall.toolCallId)
        const toolCall: ToolCallRecord = existingToolCall
          ? {
              ...existingToolCall,
              status: 'failed',
              error: errorMessage,
              finishedAt
            }
          : {
              id: event.toolCall.toolCallId,
              runId: input.runId,
              threadId: input.thread.id,
              requestMessageId: input.requestMessageId,
              toolName: event.toolCall.toolName,
              status: 'failed',
              inputSummary: summarizeToolInput(event.toolCall.toolName, event.toolCall.input),
              error: errorMessage,
              startedAt: finishedAt,
              stepIndex: stepCount,
              stepBudget: maxToolSteps,
              finishedAt
            }

        toolCalls.set(toolCall.id, toolCall)
        if (existingToolCall) {
          instrumentedUpdateToolCall(toolCall)
        } else {
          instrumentedCreateToolCall(toolCall)
          appendRecoveryToolCall(recoveryResponseMessages, {
            toolCallId: toolCall.id,
            toolName: event.toolCall.toolName,
            toolInput: event.toolCall.input
          })
        }
        persistRecoveryCheckpoint()
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })

        return 'continue'
      },
      onToolCallFinish: (event) => {
        try {
          // Reset the tool-fail loop guard whenever a tool finishes successfully.
          if (event.success) {
            recentToolErrorKeys.length = 0
            seenFailedToolCallIds.clear()
            lastLoopActionKey = undefined
          }

          if (!isTrackedToolName(event.toolCall.toolName)) {
            return
          }

          markProgress()
          textDeltaBatcher.flush()
          reasoningDeltaBatcher.flush()
          const startedToolCall = toolCalls.get(event.toolCall.toolCallId)
          const finishedAt = deps.timestamp()
          const normalized = event.success
            ? normalizeToolResult(event.toolCall.toolName, event.output)
            : undefined
          const terminalBackgroundToolCall =
            normalized?.status === 'background'
              ? deps
                  .loadThreadToolCalls(input.thread.id)
                  .find(
                    (toolCall) =>
                      toolCall.id === event.toolCall.toolCallId &&
                      (toolCall.status === 'completed' || toolCall.status === 'failed')
                  )
              : undefined
          const completedBackgroundTask =
            normalized?.status === 'background' && !terminalBackgroundToolCall
              ? resolveCompletedBackgroundBashTask(deps.getCompletedBackgroundBashTask, {
                  details: normalized.details,
                  threadId: input.thread.id,
                  toolCallId: event.toolCall.toolCallId
                })
              : undefined
          const completedBackgroundTaskDetails = completedBackgroundTask
            ? ({
                exitCode: completedBackgroundTask.exitCode,
                ...(completedBackgroundTask.cancelledByUser ? { cancelledByUser: true } : {})
              } as const)
            : undefined
          const mergedBackgroundDetails = terminalBackgroundToolCall
            ? mergeBackgroundBashDetails({
                launchDetails: normalized?.details,
                terminalDetails: terminalBackgroundToolCall.details
              })
            : completedBackgroundTaskDetails
              ? mergeBackgroundBashDetails({
                  launchDetails: normalized?.details,
                  terminalDetails: completedBackgroundTaskDetails
                })
              : normalized?.details
          const terminalBackgroundStatus =
            terminalBackgroundToolCall?.status ??
            (completedBackgroundTask
              ? getCompletedBackgroundBashStatus(completedBackgroundTask)
              : undefined)
          const terminalBackgroundOutputSummary =
            terminalBackgroundToolCall?.outputSummary ??
            (completedBackgroundTask
              ? getCompletedBackgroundBashOutputSummary(completedBackgroundTask)
              : undefined)
          const errorMessage =
            terminalBackgroundToolCall?.error ??
            (completedBackgroundTask
              ? getCompletedBackgroundBashError(completedBackgroundTask)
              : undefined) ??
            normalized?.error ??
            (event.success || event.error === undefined
              ? undefined
              : event.error instanceof Error
                ? event.error.message
                : String(event.error))
          const toolCall: ToolCallRecord = startedToolCall
            ? {
                ...startedToolCall,
                status: terminalBackgroundStatus ?? normalized?.status ?? 'failed',
                outputSummary:
                  terminalBackgroundOutputSummary ?? normalized?.outputSummary ?? errorMessage,
                ...((terminalBackgroundToolCall?.cwd ?? normalized?.cwd)
                  ? { cwd: terminalBackgroundToolCall?.cwd ?? normalized?.cwd }
                  : {}),
                ...(mergedBackgroundDetails ? { details: mergedBackgroundDetails } : {}),
                ...(errorMessage ? { error: errorMessage } : {}),
                finishedAt: terminalBackgroundToolCall?.finishedAt ?? finishedAt
              }
            : {
                id: event.toolCall.toolCallId,
                runId: input.runId,
                threadId: input.thread.id,
                requestMessageId: input.requestMessageId,
                toolName: event.toolCall.toolName,
                status: terminalBackgroundStatus ?? normalized?.status ?? 'failed',
                inputSummary: summarizeToolInput(event.toolCall.toolName, event.toolCall.input),
                outputSummary:
                  terminalBackgroundOutputSummary ?? normalized?.outputSummary ?? errorMessage,
                ...((terminalBackgroundToolCall?.cwd ?? normalized?.cwd)
                  ? { cwd: terminalBackgroundToolCall?.cwd ?? normalized?.cwd }
                  : {}),
                ...(mergedBackgroundDetails ? { details: mergedBackgroundDetails } : {}),
                ...(errorMessage ? { error: errorMessage } : {}),
                startedAt: finishedAt,
                stepIndex: ++stepCount,
                stepBudget: maxToolSteps,
                finishedAt: terminalBackgroundToolCall?.finishedAt ?? finishedAt
              }

          toolCalls.set(toolCall.id, toolCall)
          if (startedToolCall) {
            instrumentedUpdateToolCall(toolCall)
          } else {
            instrumentedCreateToolCall(toolCall)
            appendRecoveryToolCall(recoveryResponseMessages, {
              toolCallId: toolCall.id,
              toolName: event.toolCall.toolName,
              toolInput: event.toolCall.input
            })
          }
          appendRecoveryToolResult(recoveryResponseMessages, {
            toolCallId: toolCall.id,
            toolName: event.toolCall.toolName,
            output: event.output,
            error: event.error
          })
          persistRecoveryCheckpoint()
          deps.emit<ToolCallUpdatedEvent>({
            type: 'tool.updated',
            threadId: input.thread.id,
            runId: input.runId,
            toolCall
          })

          runningToolCallIds.delete(event.toolCall.toolCallId)
          if (runningToolCallIds.size === 0) {
            setExecutionPhase('generating')
          }
        } catch (error) {
          console.error('[yachiyo][tool-finish] failed to persist terminal tool state', {
            error: error instanceof Error ? error.message : String(error),
            runId: input.runId,
            success: event.success,
            threadId: input.thread.id,
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName
          })
          throw error
        }
      }
    })
    const streamIterator = stream[Symbol.asyncIterator]()

    while (true) {
      throwIfAborted(input.abortController.signal)

      const nextChunk = await streamIterator.next()
      // Re-check after the await — a cancel may have landed while we were
      // suspended, and we must not emit one more delta past the abort point.
      throwIfAborted(input.abortController.signal)
      if (nextChunk.done) {
        break
      }

      markProgress()
      const delta = nextChunk.value

      if (!delta) continue
      const deduped = consumeDuplicatePrefix({
        prefix: duplicateTextPrefix,
        pending: pendingDuplicateText,
        delta
      })
      duplicateTextPrefix = deduped.prefix
      pendingDuplicateText = deduped.pending
      if (!deduped.delta) {
        continue
      }

      textDeltaBatcher.push(deduped.delta)
    }

    textDeltaBatcher.flush()
    reasoningDeltaBatcher.flush()

    console.log(
      `[yachiyo][run] stream finished: runId=${input.runId}, finishReason=${lastUsage?.finishReason ?? 'unknown'}, ` +
        `steps=${stepCount}, bufferLen=${bufferLength}, rawOutput=${JSON.stringify(bufferParts.join('').slice(0, 300))}`
    )

    throwIfAborted(input.abortController.signal)

    // The stream finished before all tool calls received their terminal
    // result (e.g. provider truncation or a network hiccup). Route through
    // the typed retry contract so the outer recovery path picks it up.
    if (runningToolCallIds.size > 0) {
      throw new RetryableRunError('Model stream ended with incomplete tool calls')
    }

    // Detect degenerate completions: the stream finished without error but
    // produced no user-visible content (e.g. Gemini finishReason=length with
    // 0 output tokens after a network hiccup). Treat as a retryable error so
    // the recovery / fail path can handle it instead of silently "completing".
    if (bufferLength === 0 && toolCalls.size === 0) {
      const reason = lastUsage?.finishReason ?? 'unknown'
      throw new RetryableRunError(`Model returned empty response (finishReason=${reason})`)
    }

    // The model hit its max output token limit mid-generation. Even though
    // content exists, the response is incomplete — route through recovery so
    // the model can continue from the checkpoint instead of silently treating
    // a truncated response as finished.
    if (lastUsage?.finishReason === 'length') {
      throw new RetryableRunError('Model output truncated (finishReason=length)')
    }

    // Safe steer: the stream ended cleanly (via stopWhen or natural completion)
    // and a user steer is waiting at the turn boundary. Persist the assistant
    // message as 'stopped' (the run will continue with the steer as new input)
    // without completing the run itself.
    if (hasPendingSteer?.()) {
      const steerTimestamp = deps.timestamp()
      // Prefer the SDK's authoritative response.messages over the incrementally
      // built recoveryResponseMessages. The recovery messages can be incomplete
      // when a steer interrupts mid-step (e.g. parallel tool results shift to
      // later positions). The SDK's messages are finalized after the full stream
      // completes and are always self-consistent.
      const rawSteerResponseMessages =
        lastUsage?.responseMessages ??
        (recoveryResponseMessages.length > 0 ? recoveryResponseMessages : undefined)
      // Balance response messages so every tool-call has a matching tool-result.
      // Parallel tool calls interrupted by the steer may leave orphaned tool_use
      // blocks that break the next model call.
      const steerResponseMessages = rawSteerResponseMessages
        ? balanceResponseMessages(rawSteerResponseMessages)
        : rawSteerResponseMessages
      const steerAssistantMessage: MessageRecord = {
        id: messageId,
        threadId: input.thread.id,
        parentMessageId: input.requestMessageId,
        role: 'assistant',
        content: bufferParts.join(''),
        ...(textBlocks.length > 0 ? { textBlocks } : {}),
        ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
        ...(steerResponseMessages ? { responseMessages: steerResponseMessages } : {}),
        status: 'completed',
        createdAt: steerTimestamp,
        modelId: settings.model,
        providerName: settings.providerName
      }
      const steerThread = deps.readThread(input.thread.id)
      deps.storage.saveThreadMessage({
        thread: steerThread,
        updatedThread: steerThread,
        message: steerAssistantMessage
      })
      deps.emit<MessageCompletedEvent>({
        type: 'message.completed',
        threadId: input.thread.id,
        runId: input.runId,
        message: steerAssistantMessage
      })
      // Bind all tool calls from this run to the completed assistant message so
      // they are not reassigned to a later assistant message when the run continues.
      for (const [toolCallId, toolCall] of toolCalls.entries()) {
        if (toolCall.runId === input.runId && toolCall.assistantMessageId !== messageId) {
          const bound: ToolCallRecord = { ...toolCall, assistantMessageId: messageId }
          toolCalls.set(toolCallId, bound)
          instrumentedUpdateToolCall(bound)
          deps.emit<ToolCallUpdatedEvent>({
            type: 'tool.updated',
            threadId: input.thread.id,
            runId: input.runId,
            toolCall: bound
          })
        }
      }
      deps.storage.deleteRunRecoveryCheckpoint(input.runId)
      // Hand the snapshot tracker back to the caller so it persists across
      // steer legs. The same tracker accumulates file changes for the entire
      // run and is finalized only when the run reaches a terminal state.
      deps.emit<HarnessFinishedEvent>({
        type: 'harness.finished',
        threadId: input.thread.id,
        runId: input.runId,
        harnessId,
        name: DEFAULT_HARNESS_NAME,
        status: 'completed'
      })

      return {
        kind: 'steer-pending',
        assistantMessageId: messageId,
        usage: lastUsage,
        snapshotTracker: snapshotTracker ?? undefined,
        toolFailLoopSteersInjected
      }
    }

    const timestamp = deps.timestamp()
    const responseMessages = recoveryCheckpoint
      ? recoveryResponseMessages.length > 0
        ? recoveryResponseMessages
        : undefined
      : lastUsage?.responseMessages
    const assistantMessage: MessageRecord = {
      id: messageId,
      threadId: input.thread.id,
      parentMessageId: input.requestMessageId,
      role: 'assistant',
      content: bufferParts.join(''),
      ...(textBlocks.length > 0 ? { textBlocks } : {}),
      ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
      ...(responseMessages ? { responseMessages } : {}),
      status: 'completed',
      createdAt: timestamp,
      modelId: settings.model,
      providerName: settings.providerName
    }
    const currentThread = deps.readThread(input.thread.id)

    const updatedThread: ThreadRecord = {
      ...currentThread,
      updatedAt: timestamp,
      ...(input.updateHeadOnComplete
        ? { preview: assistantMessage.content.slice(0, 240) }
        : currentThread.preview
          ? { preview: currentThread.preview }
          : {}),
      ...(input.updateHeadOnComplete
        ? { headMessageId: assistantMessage.id }
        : currentThread.headMessageId
          ? { headMessageId: currentThread.headMessageId }
          : {})
    }

    // Merge prior steer-leg totals so the full run's total tokens are persisted.
    const finalUsage = mergeRunUsage(input.priorUsage, lastUsage)

    deps.storage.completeRun({
      runId: input.runId,
      updatedThread,
      assistantMessage,
      ...finalUsage,
      modelId: settings.model,
      providerName: settings.providerName
    })
    deps.onTerminalState?.()

    deps.emit<MessageCompletedEvent>({
      type: 'message.completed',
      threadId: input.thread.id,
      runId: input.runId,
      message: assistantMessage
    })
    bindCompletedToolCallsToAssistant(deps, toolCalls, {
      threadId: input.thread.id,
      runId: input.runId,
      assistantMessageId: assistantMessage.id
    })
    deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: input.thread.id,
      thread: updatedThread
    })
    // Finalize file snapshot (Layer 3 scan + persist).
    if (snapshotTracker) {
      try {
        await snapshotTracker.scanWorkspace()
        const snapshot = await snapshotTracker.finalize()
        deps.storage.updateRunSnapshot(input.runId, {
          fileCount: snapshot.entries.length,
          workspacePath: snapshotTracker.workspacePath
        })
        deps.emit<SnapshotReadyEvent>({
          type: 'snapshot.ready',
          threadId: input.thread.id,
          runId: input.runId,
          fileCount: snapshot.entries.length,
          workspacePath: snapshotTracker.workspacePath
        })
        runGc(snapshotTracker.workspaceHash).catch(() => {})
      } catch (err) {
        console.error('[snapshot] Finalization failed:', err)
      } finally {
        snapshotTracker.dispose()
      }
    }

    deps.onTerminalState?.()
    deps.emit<HarnessFinishedEvent>({
      type: 'harness.finished',
      threadId: input.thread.id,
      runId: input.runId,
      harnessId,
      name: DEFAULT_HARNESS_NAME,
      status: 'completed'
    })
    deps.emit<RunCompletedEvent>({
      type: 'run.completed',
      threadId: input.thread.id,
      runId: input.runId,
      requestMessageId: input.requestMessageId,
      ...finalUsage
    })
    perfCollector.finish(input.thread.id)

    const usedRememberTool = Array.from(toolCalls.values()).some(
      (tc) => tc.toolName === 'remember' && tc.status === 'completed' && !tc.error
    )
    return {
      kind: 'completed',
      totalPromptTokens: finalUsage?.totalPromptTokens,
      usedRememberTool
    }
  } catch (error) {
    // Reject any pending askUser promises so the tool execution unblocks
    for (const [id, pending] of pendingUserAnswers) {
      pending.reject(new Error('Run cancelled'))
      pendingUserAnswers.delete(id)
    }

    if (input.abortController.signal.aborted) {
      const restartReason = input.abortController.signal.reason
      const timestamp = deps.timestamp()

      if (isRestartRunReason(restartReason)) {
        // Drain any buffered deltas before deciding whether to persist a partial
        // assistant message. Otherwise buffered text/reasoning is dropped or the
        // partial message is skipped entirely.
        textDeltaBatcher.flush()
        reasoningDeltaBatcher.flush()

        // Mark any in-flight tool calls as failed before persisting, so the
        // buffered tool-call parts can be paired with synthetic tool-results.
        // Otherwise the next request replays an unbalanced tool_use and the
        // provider rejects the whole turn.
        finishPendingToolCalls(deps, toolCalls, {
          error: 'Run cancelled before the tool call finished.',
          finishedAt: timestamp,
          runId: input.runId,
          threadId: input.thread.id
        })
        const balancedResponseMessages =
          recoveryResponseMessages.length > 0
            ? balanceRecoveryResponseMessages(
                recoveryResponseMessages,
                Array.from(toolCalls.values())
              )
            : recoveryResponseMessages
        if (
          input.requestMessageId &&
          (bufferLength > 0 || reasoningLength > 0 || toolCalls.size > 0)
        ) {
          const currentThread = deps.readThread(input.thread.id)
          const partialAssistantMessage: MessageRecord = {
            id: messageId,
            threadId: input.thread.id,
            parentMessageId: input.requestMessageId,
            role: 'assistant',
            content: bufferParts.join(''),
            ...(textBlocks.length > 0 ? { textBlocks } : {}),
            ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
            ...(balancedResponseMessages.length > 0
              ? {
                  responseMessages: balancedResponseMessages
                }
              : {}),
            status: 'stopped',
            createdAt: timestamp,
            modelId: settings.model,
            providerName: settings.providerName
          }
          deps.storage.saveThreadMessage({
            thread: currentThread,
            updatedThread: currentThread,
            message: partialAssistantMessage
          })
          deps.emit<MessageCompletedEvent>({
            type: 'message.completed',
            threadId: input.thread.id,
            runId: input.runId,
            message: partialAssistantMessage
          })
          // Bind all tool calls from this run to the stopped assistant message so
          // they are not reassigned to a later assistant message when the run completes.
          for (const [toolCallId, toolCall] of toolCalls.entries()) {
            if (toolCall.runId === input.runId && toolCall.assistantMessageId !== messageId) {
              const bound: ToolCallRecord = { ...toolCall, assistantMessageId: messageId }
              toolCalls.set(toolCallId, bound)
              instrumentedUpdateToolCall(bound)
              deps.emit<ToolCallUpdatedEvent>({
                type: 'tool.updated',
                threadId: input.thread.id,
                runId: input.runId,
                toolCall: bound
              })
            }
          }

          const steerMessageId = restartReason.nextRequestMessageId
          const threadMessages = deps.loadThreadMessages(input.thread.id)
          const steerMessage = threadMessages.find(
            (message) => message.id === steerMessageId && message.role === 'user'
          )
          const wouldCycleSteerParent =
            steerMessage && wouldCreateParentCycle(threadMessages, steerMessage.id, messageId)
          if (wouldCycleSteerParent) {
            console.warn('[yachiyo][thread-tree] skipped cyclic steer reparent', {
              messageId: steerMessageId,
              parentMessageId: messageId,
              threadId: input.thread.id
            })
          }
          const nextSteerParentMessageId =
            steerMessage && !wouldCycleSteerParent ? messageId : undefined
          if (
            steerMessage &&
            nextSteerParentMessageId &&
            steerMessage.parentMessageId !== nextSteerParentMessageId
          ) {
            const reparentedSteerMessage: MessageRecord = {
              ...steerMessage,
              parentMessageId: nextSteerParentMessageId
            }
            deps.storage.updateMessage(reparentedSteerMessage)
            deps.emit<MessageCompletedEvent>({
              type: 'message.completed',
              threadId: input.thread.id,
              runId: input.runId,
              message: reparentedSteerMessage
            })
          }
        }

        deps.storage.deleteRunRecoveryCheckpoint(input.runId)
        // Pass the tracker through so the next leg inherits accumulated changes.
        deps.emit<HarnessFinishedEvent>({
          type: 'harness.finished',
          threadId: input.thread.id,
          runId: input.runId,
          harnessId,
          name: DEFAULT_HARNESS_NAME,
          status: 'cancelled'
        })
        return {
          kind: 'restarted',
          nextRequestMessageId: restartReason.nextRequestMessageId,
          usage: lastUsage,
          snapshotTracker: snapshotTracker ?? undefined
        }
      }

      // Cancel-with-steer: the user cancelled the run while a steer was
      // pending. Persist the stopped assistant message first so the run loop
      // can parent the steer message under it — keeping the ancestor chain
      // intact for future LLM context assembly.
      if (isCancelWithSteerReason(restartReason)) {
        textDeltaBatcher.flush()
        reasoningDeltaBatcher.flush()
        finishPendingToolCalls(deps, toolCalls, {
          error: 'Run cancelled before the tool call finished.',
          finishedAt: timestamp,
          runId: input.runId,
          threadId: input.thread.id
        })

        if (input.requestMessageId) {
          const cancelledResponseMessages =
            recoveryResponseMessages.length > 0
              ? balanceRecoveryResponseMessages(
                  recoveryResponseMessages,
                  Array.from(toolCalls.values())
                )
              : recoveryResponseMessages
          const currentThread = deps.readThread(input.thread.id)
          const stoppedMessage: MessageRecord = {
            id: messageId,
            threadId: input.thread.id,
            parentMessageId: input.requestMessageId,
            role: 'assistant',
            content: bufferParts.join(''),
            ...(textBlocks.length > 0 ? { textBlocks } : {}),
            ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
            ...(cancelledResponseMessages.length > 0
              ? { responseMessages: cancelledResponseMessages }
              : {}),
            status: 'stopped',
            createdAt: timestamp,
            modelId: settings.model,
            providerName: settings.providerName
          }
          const updatedThread: ThreadRecord = {
            ...currentThread,
            updatedAt: timestamp,
            ...(bufferLength > 0 ? { preview: bufferParts.join('').slice(0, 240) } : {}),
            ...(input.updateHeadOnComplete ? { headMessageId: messageId } : {})
          }
          deps.storage.saveThreadMessage({
            thread: currentThread,
            updatedThread,
            message: stoppedMessage
          })
          deps.emit<MessageCompletedEvent>({
            type: 'message.completed',
            threadId: input.thread.id,
            runId: input.runId,
            message: stoppedMessage
          })
          deps.emit<ThreadUpdatedEvent>({
            type: 'thread.updated',
            threadId: input.thread.id,
            thread: updatedThread
          })

          for (const [toolCallId, toolCall] of toolCalls.entries()) {
            if (toolCall.runId === input.runId && toolCall.assistantMessageId !== messageId) {
              const bound: ToolCallRecord = { ...toolCall, assistantMessageId: messageId }
              toolCalls.set(toolCallId, bound)
              instrumentedUpdateToolCall(bound)
              deps.emit<ToolCallUpdatedEvent>({
                type: 'tool.updated',
                threadId: input.thread.id,
                runId: input.runId,
                toolCall: bound
              })
            }
          }
        }

        const cancelUsage = mergeRunUsage(input.priorUsage, lastUsage)
        deps.storage.cancelRun({
          runId: input.runId,
          completedAt: timestamp,
          promptTokens: cancelUsage?.promptTokens,
          completionTokens: cancelUsage?.completionTokens,
          totalPromptTokens: cancelUsage?.totalPromptTokens,
          totalCompletionTokens: cancelUsage?.totalCompletionTokens,
          cacheReadTokens: cancelUsage?.cacheReadTokens,
          cacheWriteTokens: cancelUsage?.cacheWriteTokens
        })

        if (snapshotTracker) {
          try {
            await snapshotTracker.scanWorkspace()
            const snapshot = await snapshotTracker.finalize()
            deps.storage.updateRunSnapshot(input.runId, {
              fileCount: snapshot.entries.length,
              workspacePath: snapshotTracker.workspacePath
            })
            deps.emit<SnapshotReadyEvent>({
              type: 'snapshot.ready',
              threadId: input.thread.id,
              runId: input.runId,
              fileCount: snapshot.entries.length,
              workspacePath: snapshotTracker.workspacePath
            })
            runGc(snapshotTracker.workspaceHash).catch(() => {})
          } catch {
            // Best effort — don't fail the cancel path
          } finally {
            snapshotTracker.dispose()
          }
        }

        deps.onTerminalState?.()
        deps.emit<HarnessFinishedEvent>({
          type: 'harness.finished',
          threadId: input.thread.id,
          runId: input.runId,
          harnessId,
          name: DEFAULT_HARNESS_NAME,
          status: 'cancelled'
        })
        deps.emit<RunCancelledEvent>({
          type: 'run.cancelled',
          threadId: input.thread.id,
          runId: input.runId,
          requestMessageId: input.requestMessageId
        })
        perfCollector.finish(input.thread.id)

        return {
          kind: 'cancelled-with-steer',
          stoppedMessageId: messageId,
          steerInput: restartReason.steerInput,
          usage: cancelUsage
        }
      }

      textDeltaBatcher.flush()
      reasoningDeltaBatcher.flush()
      finishPendingToolCalls(deps, toolCalls, {
        error: 'Run cancelled before the tool call finished.',
        finishedAt: timestamp,
        runId: input.runId,
        threadId: input.thread.id
      })

      if (input.requestMessageId) {
        // Balance recovery response messages so every tool-call has a matching
        // tool-result — this keeps the stopped message valid for model replay.
        const cancelledResponseMessages =
          recoveryResponseMessages.length > 0
            ? balanceRecoveryResponseMessages(
                recoveryResponseMessages,
                Array.from(toolCalls.values())
              )
            : recoveryResponseMessages
        const currentThread = deps.readThread(input.thread.id)
        const stoppedMessage: MessageRecord = {
          id: messageId,
          threadId: input.thread.id,
          parentMessageId: input.requestMessageId,
          role: 'assistant',
          content: bufferParts.join(''),
          ...(textBlocks.length > 0 ? { textBlocks } : {}),
          ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
          ...(cancelledResponseMessages.length > 0
            ? { responseMessages: cancelledResponseMessages }
            : {}),
          status: 'stopped',
          createdAt: timestamp,
          modelId: settings.model,
          providerName: settings.providerName
        }
        const updatedThread: ThreadRecord = {
          ...currentThread,
          updatedAt: timestamp,
          ...(bufferLength > 0 ? { preview: bufferParts.join('').slice(0, 240) } : {}),
          ...(input.updateHeadOnComplete ? { headMessageId: messageId } : {})
        }
        deps.storage.saveThreadMessage({
          thread: currentThread,
          updatedThread,
          message: stoppedMessage
        })
        deps.emit<MessageCompletedEvent>({
          type: 'message.completed',
          threadId: input.thread.id,
          runId: input.runId,
          message: stoppedMessage
        })
        deps.emit<ThreadUpdatedEvent>({
          type: 'thread.updated',
          threadId: input.thread.id,
          thread: updatedThread
        })

        // Bind all tool calls from this run to the stopped assistant message.
        // Unlike the normal completion path where completeRun sets
        // assistantMessageId in storage first, here we must do it explicitly.
        for (const [toolCallId, toolCall] of toolCalls.entries()) {
          if (toolCall.runId === input.runId && toolCall.assistantMessageId !== messageId) {
            const bound: ToolCallRecord = { ...toolCall, assistantMessageId: messageId }
            toolCalls.set(toolCallId, bound)
            instrumentedUpdateToolCall(bound)
            deps.emit<ToolCallUpdatedEvent>({
              type: 'tool.updated',
              threadId: input.thread.id,
              runId: input.runId,
              toolCall: bound
            })
          }
        }
      }

      const cancelUsage = mergeRunUsage(input.priorUsage, lastUsage)
      deps.storage.cancelRun({
        runId: input.runId,
        completedAt: timestamp,
        promptTokens: cancelUsage?.promptTokens,
        completionTokens: cancelUsage?.completionTokens,
        totalPromptTokens: cancelUsage?.totalPromptTokens,
        totalCompletionTokens: cancelUsage?.totalCompletionTokens,
        cacheReadTokens: cancelUsage?.cacheReadTokens,
        cacheWriteTokens: cancelUsage?.cacheWriteTokens
      })

      // Finalize snapshot for cancelled runs so partial changes are reviewable.
      // Always scan — Layer 3 discovers files created during the run even when
      // Layer 1/2 tracking hasn't populated yet (e.g. baseline scan still running).
      if (snapshotTracker) {
        try {
          await snapshotTracker.scanWorkspace()
          const snapshot = await snapshotTracker.finalize()
          deps.storage.updateRunSnapshot(input.runId, {
            fileCount: snapshot.entries.length,
            workspacePath: snapshotTracker.workspacePath
          })
          deps.emit<SnapshotReadyEvent>({
            type: 'snapshot.ready',
            threadId: input.thread.id,
            runId: input.runId,
            fileCount: snapshot.entries.length,
            workspacePath: snapshotTracker.workspacePath
          })
          runGc(snapshotTracker.workspaceHash).catch(() => {})
        } catch {
          // Best effort — don't fail the cancel path
        } finally {
          snapshotTracker.dispose()
        }
      }

      deps.onTerminalState?.()
      deps.emit<HarnessFinishedEvent>({
        type: 'harness.finished',
        threadId: input.thread.id,
        runId: input.runId,
        harnessId,
        name: DEFAULT_HARNESS_NAME,
        status: 'cancelled'
      })
      deps.emit<RunCancelledEvent>({
        type: 'run.cancelled',
        threadId: input.thread.id,
        runId: input.runId,
        requestMessageId: input.requestMessageId
      })
      perfCollector.finish(input.thread.id)

      return { kind: 'cancelled', usage: cancelUsage }
    }

    const message = extractRetryErrorMessage(error) || 'Unknown model runtime error'
    const nextRecoveryAttempt = (recoveryCheckpoint?.recoveryAttempts ?? 0) + 1
    // Only RetryableRunError enters the recovery path. Every other error
    // class — storage/ORM failures, tool bugs, programming errors — is
    // fatal by type and drops into the `failed` branch below. No shape
    // matching, no ad-hoc properties.
    if (
      input.requestMessageId &&
      isRetryableRunError(error) &&
      nextRecoveryAttempt < RETRY_MAX_ATTEMPTS
    ) {
      textDeltaBatcher.flush()
      reasoningDeltaBatcher.flush()
      runningToolCallIds.clear()
      setExecutionPhase('generating')
      finishPendingToolCalls(deps, toolCalls, {
        error: 'Tool execution was interrupted before completion.',
        finishedAt: deps.timestamp(),
        runId: input.runId,
        threadId: input.thread.id
      })

      const checkpoint = persistRecoveryCheckpoint({
        lastError: message,
        recoveryAttempts: nextRecoveryAttempt
      })
      if (checkpoint) {
        deps.emit<RunRetryingEvent>({
          type: 'run.retrying',
          threadId: input.thread.id,
          runId: input.runId,
          attempt: checkpoint.recoveryAttempts,
          maxAttempts: RETRY_MAX_ATTEMPTS,
          delayMs: Math.min(1_000 * 2 ** Math.max(0, checkpoint.recoveryAttempts - 1), 30_000),
          error: message
        })
        return {
          kind: 'recovering',
          checkpoint,
          harnessId
        }
      }
    }

    const timestamp = deps.timestamp()

    // Flush any buffered deltas so the failed assistant message includes all
    // already-received output, consistent with cancel/retry paths.
    textDeltaBatcher.flush()
    reasoningDeltaBatcher.flush()

    finishPendingToolCalls(deps, toolCalls, {
      error: message,
      finishedAt: timestamp,
      runId: input.runId,
      threadId: input.thread.id
    })

    if (input.requestMessageId) {
      // Balance recovery response messages so every tool-call has a matching
      // tool-result — keeps the failed message valid for model replay.
      const failedResponseMessages =
        recoveryResponseMessages.length > 0
          ? balanceRecoveryResponseMessages(
              recoveryResponseMessages,
              Array.from(toolCalls.values())
            )
          : recoveryResponseMessages
      const failedMessage = persistTerminalAssistantMessage(deps, {
        runId: input.runId,
        threadId: input.thread.id,
        messageId,
        requestMessageId: input.requestMessageId,
        timestamp,
        settings,
        status: 'failed',
        content: bufferParts.join(''),
        textBlocks,
        ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
        ...(failedResponseMessages.length > 0 ? { responseMessages: failedResponseMessages } : {})
      })
      // Bind all tool calls from this run to the terminal assistant message so
      // they are not left unbound when the run fails.
      for (const [toolCallId, toolCall] of toolCalls.entries()) {
        if (toolCall.runId === input.runId && toolCall.assistantMessageId !== messageId) {
          const bound: ToolCallRecord = { ...toolCall, assistantMessageId: messageId }
          toolCalls.set(toolCallId, bound)
          instrumentedUpdateToolCall(bound)
          deps.emit<ToolCallUpdatedEvent>({
            type: 'tool.updated',
            threadId: input.thread.id,
            runId: input.runId,
            toolCall: bound
          })
        }
      }
      deps.emit<MessageCompletedEvent>({
        type: 'message.completed',
        threadId: input.thread.id,
        runId: input.runId,
        message: failedMessage
      })
      const currentThread = deps.readThread(input.thread.id)
      deps.emit<ThreadUpdatedEvent>({
        type: 'thread.updated',
        threadId: input.thread.id,
        thread: { ...currentThread, updatedAt: timestamp }
      })
    }

    const failUsage = mergeRunUsage(input.priorUsage, lastUsage)
    deps.storage.failRun({
      runId: input.runId,
      completedAt: timestamp,
      error: message,
      promptTokens: failUsage?.promptTokens,
      completionTokens: failUsage?.completionTokens,
      totalPromptTokens: failUsage?.totalPromptTokens,
      totalCompletionTokens: failUsage?.totalCompletionTokens,
      cacheReadTokens: failUsage?.cacheReadTokens,
      cacheWriteTokens: failUsage?.cacheWriteTokens
    })

    // Finalize file snapshot for failed runs so partial changes are reviewable.
    // Always scan — Layer 3 discovers files created during the run even when
    // Layer 1/2 tracking hasn't populated yet (e.g. baseline scan still running).
    if (snapshotTracker) {
      try {
        await snapshotTracker.scanWorkspace()
        const snapshot = await snapshotTracker.finalize()
        deps.storage.updateRunSnapshot(input.runId, {
          fileCount: snapshot.entries.length,
          workspacePath: snapshotTracker.workspacePath
        })
        deps.emit<SnapshotReadyEvent>({
          type: 'snapshot.ready',
          threadId: input.thread.id,
          runId: input.runId,
          fileCount: snapshot.entries.length,
          workspacePath: snapshotTracker.workspacePath
        })
        runGc(snapshotTracker.workspaceHash).catch(() => {})
      } catch {
        // Best effort — don't fail the failure path
      } finally {
        snapshotTracker.dispose()
      }
    }

    deps.onTerminalState?.()
    deps.emit<HarnessFinishedEvent>({
      type: 'harness.finished',
      threadId: input.thread.id,
      runId: input.runId,
      harnessId,
      name: DEFAULT_HARNESS_NAME,
      status: 'failed',
      error: message
    })
    deps.emit<RunFailedEvent>({
      type: 'run.failed',
      threadId: input.thread.id,
      runId: input.runId,
      requestMessageId: input.requestMessageId,
      error: message
    })
    perfCollector.finish(input.thread.id)
    return { kind: 'failed', usage: failUsage }
  } finally {
    const jsReplTool = tools?.jsRepl as { dispose?: () => Promise<void> } | undefined
    if (jsReplTool?.dispose) {
      await jsReplTool.dispose().catch(() => {})
    }
  }
}
