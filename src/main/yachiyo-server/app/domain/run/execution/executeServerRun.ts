import { stepCountIs, type StopCondition, type ToolSet } from 'ai'
import { performance } from 'node:perf_hooks'

import { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'

import type {
  MessageDeltaEvent,
  MessageReasoningDeltaEvent,
  MessageStartedEvent,
  MessageTextBlockRecord,
  RunRetryingEvent,
  RunUsageUpdatedEvent,
  ToolCallRecord,
  ToolCallUpdatedEvent
} from '../../../../../../shared/yachiyo/protocol.ts'
import { isTrackedToolName } from '../../../../../../shared/yachiyo/protocol.ts'
import { createRunPerfCollector } from '../../../../services/perfMonitor.ts'
import type { ModelUsage } from '../../../../runtime/types.ts'
import { RetryableRunError } from '../../../../runtime/runtimeErrors.ts'
import { normalizeToolResult, summarizeToolInput } from '../../../../tools/agentTools.ts'
import { createDeltaBatcher } from '../../shared.ts'
import {
  appendRecoveryReasoningDelta,
  appendRecoveryTextDelta,
  appendRecoveryToolCall,
  appendRecoveryToolResult,
  buildRecoveryResponseMessages,
  cloneRecoveryResponseMessages,
  type RecoveryResponseMessage
} from '../../runRecovery.ts'
import { prepareServerRunContext } from '../context/prepareServerRunContext.ts'
import { appendMessageDeltaToTextBlocks } from './textBlocks.ts'
import {
  getCompletedBackgroundBashError,
  getCompletedBackgroundBashOutputSummary,
  getCompletedBackgroundBashStatus,
  mergeBackgroundBashDetails,
  resolveCompletedBackgroundBashTask
} from '../tools/backgroundBashToolResult.ts'
import {
  bindRunToolCallsToAssistant,
  restorePersistedRunToolCalls
} from '../tools/toolCallLifecycle.ts'
import { consumeDuplicatePrefix } from './streamDedup.ts'
import { createRecoveryCheckpointManager } from './recoveryCheckpointManager.ts'
import { handleAbortedRun } from './runAbortHandling.ts'
import { handleCompletedRun } from './runCompletionHandling.ts'
import { extractRetryErrorMessage, handleRunFailure } from './runFailureHandling.ts'
import { createRunToolSet } from './runToolSetFactory.ts'
import type { ExecuteRunInput, ExecuteRunResult, RunExecutionDeps } from './runExecutionTypes.ts'

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
  const recoveryCheckpoint = input.recoveryCheckpoint
  const messageId = recoveryCheckpoint?.assistantMessageId ?? deps.createId()
  const toolCalls = recoveryCheckpoint
    ? restorePersistedRunToolCalls(deps.loadThreadToolCalls, input.thread.id, input.runId)
    : new Map<string, ToolCallRecord>()
  const bindCurrentRunToolCallsToAssistant = (assistantMessageId: string): void => {
    bindRunToolCallsToAssistant(
      { emit: deps.emit, updateToolCall: instrumentedUpdateToolCall },
      toolCalls,
      {
        threadId: input.thread.id,
        runId: input.runId,
        assistantMessageId
      }
    )
  }
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
  let recoveryResponseMessages: RecoveryResponseMessage[] =
    (buildRecoveryResponseMessages({
      checkpoint: recoveryCheckpoint ?? { content: bufferParts.join('') },
      toolCalls: [...toolCalls.values()]
    }) as RecoveryResponseMessage[] | undefined) ?? []
  const getCurrentOutputSnapshot = (): {
    content: string
    bufferLength: number
    reasoning?: string
    reasoningLength: number
    textBlocks: MessageTextBlockRecord[]
    recoveryResponseMessages: RecoveryResponseMessage[]
  } => ({
    content: bufferParts.join(''),
    bufferLength,
    ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
    reasoningLength,
    textBlocks,
    recoveryResponseMessages
  })

  const recoveryCheckpointManager = createRecoveryCheckpointManager({
    deps,
    executionInput: input,
    getSnapshot: () => {
      const snapshot = getCurrentOutputSnapshot()
      return {
        content: snapshot.content,
        textBlocks: snapshot.textBlocks,
        ...(snapshot.reasoning ? { reasoning: snapshot.reasoning } : {}),
        responseMessages: snapshot.recoveryResponseMessages
      }
    },
    messageId,
    perfCollector,
    recoveryCheckpoint
  })
  const persistRecoveryCheckpoint = recoveryCheckpointManager.persist
  const persistRecoveryCheckpointThrottled = recoveryCheckpointManager.persistThrottled

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
    const { workspacePath, messages: finalMessages, maxToolSteps } = preparedContext
    if (!snapshotTracker) {
      snapshotTracker = new SnapshotTracker(workspacePath, input.runId, input.thread.id)
      snapshotTracker.startBaselineScan()
    }
    const runtime = deps.createModelRuntime()
    tools = createRunToolSet({
      createToolCall: instrumentedCreateToolCall,
      deps,
      executionInput: input,
      getStepCount: () => stepCount,
      markProgress,
      maxToolSteps,
      pendingUserAnswers,
      persistRecoveryCheckpoint,
      preparedContext,
      setExecutionPhase,
      snapshotTracker,
      subagentStartedAtByDelegationId,
      toolCalls,
      updateToolCall: instrumentedUpdateToolCall
    })
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

    return handleCompletedRun({
      bindCurrentRunToolCallsToAssistant,
      deps,
      executionInput: input,
      getOutputSnapshot: getCurrentOutputSnapshot,
      hasPendingSteer,
      lastUsage,
      messageId,
      perfCollector,
      recoveredFromCheckpoint: Boolean(recoveryCheckpoint),
      settings,
      snapshotTracker,
      toolCalls,
      toolFailLoopSteersInjected
    })
  } catch (error) {
    // Reject any pending askUser promises so the tool execution unblocks
    for (const [id, pending] of pendingUserAnswers) {
      pending.reject(new Error('Run cancelled'))
      pendingUserAnswers.delete(id)
    }

    const abortedResult = await handleAbortedRun({
      bindCurrentRunToolCallsToAssistant,
      deps,
      executionInput: input,
      flushDeltas: () => {
        textDeltaBatcher.flush()
        reasoningDeltaBatcher.flush()
      },
      getOutputSnapshot: getCurrentOutputSnapshot,
      lastUsage,
      messageId,
      perfCollector,
      settings,
      snapshotTracker,
      toolCalls
    })
    if (abortedResult) {
      return abortedResult
    }

    return handleRunFailure({
      bindCurrentRunToolCallsToAssistant,
      deps,
      error,
      executionInput: input,
      flushDeltas: () => {
        textDeltaBatcher.flush()
        reasoningDeltaBatcher.flush()
      },
      getOutputSnapshot: getCurrentOutputSnapshot,
      lastUsage,
      messageId,
      perfCollector,
      persistRecoveryCheckpoint,
      recoveryAttempts: recoveryCheckpoint?.recoveryAttempts ?? 0,
      runningToolCallIds,
      setExecutionPhase,
      settings,
      snapshotTracker,
      toolCalls
    })
  } finally {
    const jsReplTool = tools?.jsRepl as { dispose?: () => Promise<void> } | undefined
    if (jsReplTool?.dispose) {
      await jsReplTool.dispose().catch(() => {})
    }
  }
}
