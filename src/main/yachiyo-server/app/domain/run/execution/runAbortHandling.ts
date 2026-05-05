import type {
  MessageCompletedEvent,
  MessageRecord,
  MessageTextBlockRecord,
  ProviderSettings,
  RunCancelledEvent,
  ThreadUpdatedEvent
} from '../../../../../../shared/yachiyo/protocol.ts'
import { wouldCreateParentCycle } from '../../../../../../shared/yachiyo/threadTree.ts'
import type { ModelUsage } from '../../../../runtime/models/types.ts'
import type { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import type { RunPerfCollector } from '../../../../services/perfMonitor.ts'
import { balanceRecoveryResponseMessages, type RecoveryResponseMessage } from '../runRecovery.ts'
import { usageFieldsFrom } from '../runUsageFields.ts'
import { finishPendingToolCalls } from '../tools/toolCallLifecycle.ts'
import { finalizeRunSnapshot } from './runSnapshotFinalize.ts'
import { mergeRunUsage } from './runUsage.ts'
import { persistThreadAssistantMessage } from './terminalPersistence.ts'
import type { RunToolLifecycleState } from './runToolLifecycleState.ts'
import type {
  CancelWithSteerReason,
  ExecuteRunInput,
  ExecuteRunResult,
  RestartRunReason,
  RunExecutionDeps
} from './runExecutionTypes.ts'

interface RunAbortOutputSnapshot {
  content: string
  bufferLength: number
  reasoning?: string
  reasoningLength: number
  textBlocks: MessageTextBlockRecord[]
  recoveryResponseMessages: RecoveryResponseMessage[]
}

interface HandleAbortedRunInput {
  bindCurrentRunToolCallsToAssistant: (assistantMessageId: string) => void
  deps: RunExecutionDeps
  executionInput: ExecuteRunInput
  flushDeltas: () => void
  getOutputSnapshot: () => RunAbortOutputSnapshot
  lastUsage?: ModelUsage
  messageId: string
  perfCollector: RunPerfCollector
  settings: ProviderSettings
  snapshotTracker: SnapshotTracker | null
  toolLifecycle: RunToolLifecycleState
}

export function isRestartRunReason(value: unknown): value is RestartRunReason {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'restart' &&
    typeof (value as { nextRequestMessageId?: unknown }).nextRequestMessageId === 'string'
  )
}

export function isCancelWithSteerReason(value: unknown): value is CancelWithSteerReason {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'cancel-with-steer' &&
    (value as { steerInput?: unknown }).steerInput != null
  )
}

export async function handleAbortedRun(
  input: HandleAbortedRunInput
): Promise<ExecuteRunResult | undefined> {
  if (!input.executionInput.abortController.signal.aborted) {
    return undefined
  }

  const reason = input.executionInput.abortController.signal.reason
  const timestamp = input.deps.timestamp()

  if (isRestartRunReason(reason)) {
    return handleRestartRunAbort(input, reason, timestamp)
  }

  if (isCancelWithSteerReason(reason)) {
    return handleCancelledRun(input, timestamp, {
      kind: 'cancelled-with-steer',
      steerInput: reason.steerInput
    })
  }

  return handleCancelledRun(input, timestamp, { kind: 'cancelled' })
}

function handleRestartRunAbort(
  input: HandleAbortedRunInput,
  reason: RestartRunReason,
  timestamp: string
): ExecuteRunResult {
  input.flushDeltas()
  finishInterruptedToolCalls(input, timestamp, 'Run cancelled before the tool call finished.')

  const snapshot = input.getOutputSnapshot()
  const balancedResponseMessages = balanceStoppedResponseMessages(input.toolLifecycle, snapshot)
  if (
    input.executionInput.requestMessageId &&
    (snapshot.bufferLength > 0 ||
      snapshot.reasoningLength > 0 ||
      input.toolLifecycle.hasToolCalls())
  ) {
    const { assistantMessage: partialAssistantMessage } = persistThreadAssistantMessage(
      input.deps,
      {
        threadId: input.executionInput.thread.id,
        messageId: input.messageId,
        requestMessageId: input.executionInput.requestMessageId,
        timestamp,
        settings: input.settings,
        status: 'stopped',
        content: snapshot.content,
        textBlocks: snapshot.textBlocks,
        ...(snapshot.reasoning ? { reasoning: snapshot.reasoning } : {}),
        ...(balancedResponseMessages.length > 0
          ? { responseMessages: balancedResponseMessages }
          : {}),
        resolveUpdatedThread: (thread) => thread
      }
    )
    input.deps.emit<MessageCompletedEvent>({
      type: 'message.completed',
      threadId: input.executionInput.thread.id,
      runId: input.executionInput.runId,
      message: partialAssistantMessage
    })
    input.bindCurrentRunToolCallsToAssistant(input.messageId)
    reparentSteerMessage(input, reason.nextRequestMessageId)
  }

  input.deps.storage.deleteRunRecoveryCheckpoint(input.executionInput.runId)
  return {
    kind: 'restarted',
    nextRequestMessageId: reason.nextRequestMessageId,
    usage: input.lastUsage,
    snapshotTracker: input.snapshotTracker ?? undefined
  }
}

async function handleCancelledRun(
  input: HandleAbortedRunInput,
  timestamp: string,
  result:
    | { kind: 'cancelled' }
    | { kind: 'cancelled-with-steer'; steerInput: CancelWithSteerReason['steerInput'] }
): Promise<ExecuteRunResult> {
  input.flushDeltas()
  finishInterruptedToolCalls(input, timestamp, 'Run cancelled before the tool call finished.')

  const snapshot = input.getOutputSnapshot()
  const cancelledResponseMessages = balanceStoppedResponseMessages(input.toolLifecycle, snapshot)
  if (input.executionInput.requestMessageId) {
    const { assistantMessage: stoppedMessage, updatedThread } = persistThreadAssistantMessage(
      input.deps,
      {
        threadId: input.executionInput.thread.id,
        messageId: input.messageId,
        requestMessageId: input.executionInput.requestMessageId,
        timestamp,
        settings: input.settings,
        status: 'stopped',
        content: snapshot.content,
        textBlocks: snapshot.textBlocks,
        ...(snapshot.reasoning ? { reasoning: snapshot.reasoning } : {}),
        ...(cancelledResponseMessages.length > 0
          ? { responseMessages: cancelledResponseMessages }
          : {}),
        resolveUpdatedThread: (thread) => ({
          ...thread,
          updatedAt: timestamp,
          ...(snapshot.bufferLength > 0 ? { preview: snapshot.content.slice(0, 240) } : {}),
          ...(input.executionInput.updateHeadOnComplete ? { headMessageId: input.messageId } : {})
        })
      }
    )
    input.deps.emit<MessageCompletedEvent>({
      type: 'message.completed',
      threadId: input.executionInput.thread.id,
      runId: input.executionInput.runId,
      message: stoppedMessage
    })
    input.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: input.executionInput.thread.id,
      thread: updatedThread
    })
    input.bindCurrentRunToolCallsToAssistant(input.messageId)
  }

  const cancelUsage = mergeRunUsage(input.executionInput.priorUsage, input.lastUsage)
  input.deps.storage.cancelRun({
    runId: input.executionInput.runId,
    completedAt: timestamp,
    ...usageFieldsFrom(cancelUsage)
  })

  await finalizeRunSnapshot({
    deps: input.deps,
    runId: input.executionInput.runId,
    snapshotTracker: input.snapshotTracker,
    threadId: input.executionInput.thread.id,
    perfCollector: input.perfCollector
  })

  input.deps.onTerminalState?.()
  input.deps.emit<RunCancelledEvent>({
    type: 'run.cancelled',
    threadId: input.executionInput.thread.id,
    runId: input.executionInput.runId,
    requestMessageId: input.executionInput.requestMessageId
  })
  input.perfCollector.finish(input.executionInput.thread.id)

  if (result.kind === 'cancelled-with-steer') {
    return {
      kind: 'cancelled-with-steer',
      stoppedMessageId: input.messageId,
      steerInput: result.steerInput,
      usage: cancelUsage
    }
  }

  return { kind: 'cancelled', usage: cancelUsage }
}

function balanceStoppedResponseMessages(
  toolLifecycle: RunToolLifecycleState,
  snapshot: RunAbortOutputSnapshot
): RecoveryResponseMessage[] {
  return snapshot.recoveryResponseMessages.length > 0
    ? balanceRecoveryResponseMessages(
        snapshot.recoveryResponseMessages,
        toolLifecycle.getAllToolCalls()
      )
    : snapshot.recoveryResponseMessages
}

function finishInterruptedToolCalls(
  input: HandleAbortedRunInput,
  timestamp: string,
  error: string
): void {
  finishPendingToolCalls(input.deps, input.toolLifecycle.toolCalls, {
    error,
    finishedAt: timestamp,
    runId: input.executionInput.runId,
    threadId: input.executionInput.thread.id
  })
}

function reparentSteerMessage(input: HandleAbortedRunInput, steerMessageId: string): void {
  const threadMessages = input.deps.loadThreadMessages(input.executionInput.thread.id)
  const steerMessage = threadMessages.find(
    (message) => message.id === steerMessageId && message.role === 'user'
  )
  const wouldCycleSteerParent =
    steerMessage && wouldCreateParentCycle(threadMessages, steerMessage.id, input.messageId)
  if (wouldCycleSteerParent) {
    console.warn('[yachiyo][thread-tree] skipped cyclic steer reparent', {
      messageId: steerMessageId,
      parentMessageId: input.messageId,
      threadId: input.executionInput.thread.id
    })
  }

  const nextSteerParentMessageId =
    steerMessage && !wouldCycleSteerParent ? input.messageId : undefined
  if (
    steerMessage &&
    nextSteerParentMessageId &&
    steerMessage.parentMessageId !== nextSteerParentMessageId
  ) {
    const reparentedSteerMessage: MessageRecord = {
      ...steerMessage,
      parentMessageId: nextSteerParentMessageId
    }
    input.deps.storage.updateMessage(reparentedSteerMessage)
    input.deps.emit<MessageCompletedEvent>({
      type: 'message.completed',
      threadId: input.executionInput.thread.id,
      runId: input.executionInput.runId,
      message: reparentedSteerMessage
    })
  }
}
