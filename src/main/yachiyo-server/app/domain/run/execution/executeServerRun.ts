import { stepCountIs, type StopCondition, type ToolSet } from 'ai'
import { performance } from 'node:perf_hooks'

import { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'

import type {
  MessageDeltaEvent,
  MessageReasoningDeltaEvent,
  MessageStartedEvent,
  RunRetryingEvent,
  RunUsageUpdatedEvent,
  ToolCallRecord,
  ToolCallUpdatedEvent
} from '../../../../../../shared/yachiyo/protocol.ts'
import { isTrackedToolName } from '../../../../../../shared/yachiyo/protocol.ts'
import { createRunPerfCollector } from '../../../../services/perfMonitor.ts'
import type { ModelUsage } from '../../../../runtime/models/types.ts'
import { RetryableRunError } from '../../../../runtime/models/runtimeErrors.ts'
import { normalizeToolResult, summarizeToolInput } from '../../../../tools/agentTools.ts'
import { createDeltaBatcher } from '../../shared/shared.ts'
import type { RunExecutionPhase } from '../runTypes.ts'
import { prepareServerRunContext } from '../context/prepareServerRunContext.ts'
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
import { createRecoveryCheckpointManager } from './recoveryCheckpointManager.ts'
import { handleAbortedRun } from './runAbortHandling.ts'
import { handleCompletedRun } from './runCompletionHandling.ts'
import { extractRetryErrorMessage, handleRunFailure } from './runFailureHandling.ts'
import { createRunOutputState } from './runOutputState.ts'
import { createRunToolSet } from './runToolSetFactory.ts'
import { createRunToolLifecycleState } from './runToolLifecycleState.ts'
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
  const restoredToolCalls = recoveryCheckpoint
    ? restorePersistedRunToolCalls(deps.loadThreadToolCalls, input.thread.id, input.runId)
    : new Map<string, ToolCallRecord>()
  const toolLifecycle = createRunToolLifecycleState({
    initialToolCalls: restoredToolCalls,
    priorToolFailLoopSteers: input.priorToolFailLoopSteers
  })
  const bindCurrentRunToolCallsToAssistant = (assistantMessageId: string): void => {
    bindRunToolCallsToAssistant(
      { emit: deps.emit, updateToolCall: instrumentedUpdateToolCall },
      toolLifecycle.toolCalls,
      {
        threadId: input.thread.id,
        runId: input.runId,
        assistantMessageId
      }
    )
  }
  const subagentStartedAtByDelegationId = new Map<string, string>()
  let executionPhase: RunExecutionPhase = 'generating'
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

  const outputState = createRunOutputState({
    deps: {
      createId: deps.createId,
      timestamp: deps.timestamp
    },
    recoveryCheckpoint,
    toolCalls: toolLifecycle.getAllToolCalls()
  })
  const getCurrentOutputSnapshot = outputState.getSnapshot

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
      outputState.appendTextDelta(batch)
      persistRecoveryCheckpointThrottled()
      perfCollector.recordDeltaEvent()
      if (streamStartedAt !== undefined) {
        perfCollector.recordFirstTextDelta(performance.now() - streamStartedAt)
      }
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
      outputState.appendReasoningDelta(batch)
      persistRecoveryCheckpointThrottled()
      perfCollector.recordReasoningDeltaEvent()
      if (streamStartedAt !== undefined) {
        perfCollector.recordFirstReasoningDelta(performance.now() - streamStartedAt)
      }
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

  const flushDeltas = (): void => {
    textDeltaBatcher.flush()
    reasoningDeltaBatcher.flush()
  }

  const setExecutionPhase = (phase: RunExecutionPhase): void => {
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
  let streamStartedAt: number | undefined
  let streamDurationRecorded = false
  const recordModelStreamDuration = (): void => {
    if (streamStartedAt === undefined || streamDurationRecorded) {
      return
    }

    streamDurationRecorded = true
    perfCollector.recordModelStream(performance.now() - streamStartedAt)
  }

  try {
    const contextPrepareStartedAt = performance.now()
    const preparedContext = await prepareServerRunContext(deps, {
      runId: input.runId,
      thread: input.thread,
      requestMessageId: input.requestMessageId,
      enabledTools: input.enabledTools,
      ...(input.enabledSkillNames !== undefined
        ? { enabledSkillNames: input.enabledSkillNames }
        : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      runTrigger: input.runTrigger,
      ...(input.channelHint ? { channelHint: input.channelHint } : {}),
      abortController: input.abortController,
      ...(input.recoveryCheckpoint ? { recoveryCheckpoint: input.recoveryCheckpoint } : {}),
      ...(input.isSteerLeg !== undefined ? { isSteerLeg: input.isSteerLeg } : {}),
      ...(input.priorUsage ? { priorUsage: input.priorUsage } : {}),
      ...(input.maxToolStepsOverride !== undefined
        ? { maxToolStepsOverride: input.maxToolStepsOverride }
        : {})
    })
    perfCollector.recordContextPreparation(performance.now() - contextPrepareStartedAt, {
      activeSkillCount: preparedContext.activeSkills.length,
      availableSkillCount: preparedContext.availableSkills.length,
      fileMentionCount: preparedContext.fileMentionCount,
      inlinedFileCount: preparedContext.inlinedFileCount,
      memoryEntryCount: preparedContext.memoryEntries.length,
      messageCount: preparedContext.messages.length
    })
    const { workspacePath, messages: finalMessages, maxToolSteps } = preparedContext
    if (!snapshotTracker) {
      snapshotTracker = new SnapshotTracker(workspacePath, input.runId, input.thread.id)
      snapshotTracker.startBaselineScan()
    }
    deps.onSnapshotTrackerReady?.(snapshotTracker)
    const runtime = deps.createModelRuntime()
    tools = createRunToolSet({
      createToolCall: instrumentedCreateToolCall,
      deps,
      executionInput: input,
      markProgress,
      maxToolSteps,
      pendingUserAnswers,
      persistRecoveryCheckpoint,
      preparedContext,
      setExecutionPhase,
      snapshotTracker,
      subagentStartedAtByDelegationId,
      toolLifecycle,
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

    streamStartedAt = performance.now()
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
        outputState.rebuildRecoveryMessages(toolLifecycle.getAllToolCalls())
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
        outputState.markNextTextBlock()

        const toolCall: ToolCallRecord = {
          id: event.toolCallId,
          runId: input.runId,
          threadId: input.thread.id,
          requestMessageId: input.requestMessageId,
          toolName: event.toolName,
          status: 'preparing',
          inputSummary: '',
          startedAt: deps.timestamp(),
          stepIndex: toolLifecycle.nextPreparingStepIndex(),
          stepBudget: maxToolSteps
        }

        toolLifecycle.setToolCall(toolCall)
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
        toolLifecycle.markRunningToolCall(event.toolCall.toolCallId)
        outputState.markNextTextBlock()
        setExecutionPhase('tool-running')
        const stepIndex = toolLifecycle.advanceStep()

        // Upgrade from 'preparing' if the early record exists, otherwise create fresh.
        // The preparing record may have been stored under a different key if
        // the fullStream's tool-input-start `part.id` diverged from the SDK's
        // canonical `toolCallId`. When the direct lookup misses, fall back to
        // the most recent preparing record for the same tool name and clean up
        // the stale key so the map stays consistent.
        const { existing, orphanedPreparingKey } = toolLifecycle.findPreparingToolCall({
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName
        })
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
          stepIndex,
          stepBudget: maxToolSteps
        }

        // Remove the orphaned preparing entry from the in-memory map so it
        // doesn't linger or get bound to the assistant message with a stale ID.
        // The storage record will be superseded by the create/update below.
        if (orphanedPreparingKey) {
          toolLifecycle.deleteToolCall(orphanedPreparingKey)
        }

        toolLifecycle.setToolCall(toolCall)
        if (upgradingFromPreparing && !orphanedPreparingKey) {
          // Normal upgrade: same key, record exists in storage.
          instrumentedUpdateToolCall(toolCall)
        } else {
          // Either fresh record or the ID changed (orphan remap) — the old
          // storage row is keyed by the stale ID so update would be a no-op.
          // Always create a new row under the canonical ID.
          instrumentedCreateToolCall(toolCall)
        }
        outputState.appendToolCall({
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

        const startedToolCall = toolLifecycle.getToolCall(event.toolCall.toolCallId)
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

        toolLifecycle.setToolCall(toolCall)
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
        const errorMessage =
          event.error instanceof Error ? event.error.message : String(event.error)
        const steerContent = toolLifecycle.recordToolFailureLoop({
          errorMessage,
          toolCallId: event.toolCall.toolCallId,
          toolInput: event.toolCall.input,
          toolName: event.toolCall.toolName
        })
        if (steerContent) {
          deps.injectPendingSteer?.({ content: steerContent })
        }

        if (!isTrackedToolName(event.toolCall.toolName)) {
          return 'continue'
        }

        markProgress()
        textDeltaBatcher.flush()
        reasoningDeltaBatcher.flush()
        setExecutionPhase('tool-running')
        const stepIndex = toolLifecycle.advanceStep()

        const finishedAt = deps.timestamp()
        const existingToolCall = toolLifecycle.getToolCall(event.toolCall.toolCallId)
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
              stepIndex,
              stepBudget: maxToolSteps,
              finishedAt
            }

        toolLifecycle.setToolCall(toolCall)
        if (existingToolCall) {
          instrumentedUpdateToolCall(toolCall)
        } else {
          instrumentedCreateToolCall(toolCall)
          outputState.appendToolCall({
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
            toolLifecycle.resetToolFailureLoop()
          }

          if (!isTrackedToolName(event.toolCall.toolName)) {
            return
          }

          markProgress()
          textDeltaBatcher.flush()
          reasoningDeltaBatcher.flush()
          const startedToolCall = toolLifecycle.getToolCall(event.toolCall.toolCallId)
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
                stepIndex: toolLifecycle.advanceStep(),
                stepBudget: maxToolSteps,
                finishedAt: terminalBackgroundToolCall?.finishedAt ?? finishedAt
              }

          toolLifecycle.setToolCall(toolCall)
          if (startedToolCall) {
            instrumentedUpdateToolCall(toolCall)
          } else {
            instrumentedCreateToolCall(toolCall)
            outputState.appendToolCall({
              toolCallId: toolCall.id,
              toolName: event.toolCall.toolName,
              toolInput: event.toolCall.input
            })
          }
          outputState.appendToolResult({
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

          if (toolLifecycle.finishRunningToolCall(event.toolCall.toolCallId)) {
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
      const dedupedDelta = outputState.consumeTextDelta(delta)
      if (!dedupedDelta) {
        continue
      }

      textDeltaBatcher.push(dedupedDelta)
    }

    flushDeltas()
    recordModelStreamDuration()

    const outputSnapshot = outputState.getSnapshot()
    console.log(
      `[yachiyo][run] stream finished: runId=${input.runId}, finishReason=${lastUsage?.finishReason ?? 'unknown'}, ` +
        `steps=${toolLifecycle.getStepCount()}, bufferLen=${outputSnapshot.bufferLength}, rawOutput=${JSON.stringify(outputSnapshot.content.slice(0, 300))}`
    )

    throwIfAborted(input.abortController.signal)

    // The stream finished before all tool calls received their terminal
    // result (e.g. provider truncation or a network hiccup). Route through
    // the typed retry contract so the outer recovery path picks it up.
    if (toolLifecycle.hasRunningToolCalls()) {
      throw new RetryableRunError('Model stream ended with incomplete tool calls')
    }

    // Detect degenerate completions: the stream finished without error but
    // produced no user-visible content (e.g. Gemini finishReason=length with
    // 0 output tokens after a network hiccup). Treat as a retryable error so
    // the recovery / fail path can handle it instead of silently "completing".
    if (!outputState.hasTextContent() && !toolLifecycle.hasToolCalls()) {
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
      toolLifecycle
    })
  } catch (error) {
    flushDeltas()
    recordModelStreamDuration()
    // Reject any pending askUser promises so the tool execution unblocks
    for (const [id, pending] of pendingUserAnswers) {
      pending.reject(new Error('Run cancelled'))
      pendingUserAnswers.delete(id)
    }

    const abortedResult = await handleAbortedRun({
      bindCurrentRunToolCallsToAssistant,
      deps,
      executionInput: input,
      flushDeltas,
      getOutputSnapshot: getCurrentOutputSnapshot,
      lastUsage,
      messageId,
      perfCollector,
      settings,
      snapshotTracker,
      toolLifecycle
    })
    if (abortedResult) {
      return abortedResult
    }

    return handleRunFailure({
      bindCurrentRunToolCallsToAssistant,
      deps,
      error,
      executionInput: input,
      flushDeltas,
      getOutputSnapshot: getCurrentOutputSnapshot,
      lastUsage,
      messageId,
      perfCollector,
      persistRecoveryCheckpoint,
      recoveryAttempts: recoveryCheckpoint?.recoveryAttempts ?? 0,
      setExecutionPhase,
      settings,
      snapshotTracker,
      toolLifecycle
    })
  } finally {
    const jsReplTool = tools?.jsRepl as { dispose?: () => Promise<void> } | undefined
    if (jsReplTool?.dispose) {
      await jsReplTool.dispose().catch(() => {})
    }
  }
}
