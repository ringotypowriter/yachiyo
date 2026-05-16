import type { RunCancelledEvent, ThreadRecord } from '../../../../../../shared/yachiyo/protocol.ts'
import type { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import type { ActiveRunLoopInput } from '../active/activeRunStart.ts'
import { persistSteerMessage, type SendChatFlowContext } from '../chat/sendChatFlow.ts'
import type { ExecuteRunInput, ExecuteRunResult } from '../execution/runExecutionTypes.ts'
import { usageFieldsFrom } from '../runUsageFields.ts'
import type { RunDomainDeps, RunState } from '../runTypes.ts'
import { emitThreadStateReplaced, type FollowUpQueueContext } from '../queue/followUpQueue.ts'
import { accumulateRunLoopUsage, mergeUsageForTerminal } from './runUsage.ts'

type SteerPendingRunResult = Extract<ExecuteRunResult, { kind: 'steer-pending' }>
type CancelledRunResult = Extract<ExecuteRunResult, { kind: 'cancelled' }>
type CancelledWithSteerRunResult = Extract<ExecuteRunResult, { kind: 'cancelled-with-steer' }>

export interface RunLoopSteerContext {
  deps: RunDomainDeps
  createSendChatFlowContext: () => SendChatFlowContext
  createFollowUpQueueContext: () => FollowUpQueueContext
}

export type HandleSteerPendingResult =
  | {
      kind: 'cancelled'
      accumulatedUsage: ExecuteRunInput['priorUsage'] | undefined
      result: CancelledRunResult
    }
  | {
      kind: 'continue'
      accumulatedUsage: ExecuteRunInput['priorUsage'] | undefined
      carriedSnapshotTracker: SnapshotTracker | undefined
      carriedToolFailLoopSteers: number
      currentRequestMessageId: string
      currentThread: ThreadRecord
    }

export async function handleSteerPendingResult(
  context: RunLoopSteerContext,
  input: {
    accumulatedUsage: ExecuteRunInput['priorUsage'] | undefined
    activeRun: RunState
    carriedToolFailLoopSteers: number
    currentRequestMessageId: string
    loopInput: ActiveRunLoopInput
    result: SteerPendingRunResult
  }
): Promise<HandleSteerPendingResult> {
  const steerInput = input.activeRun.pendingSteerInput

  if (!steerInput) {
    // The steer was withdrawn after execution finished at a safe turn boundary.
    input.result.snapshotTracker?.dispose()
    const steerPendingUsage = mergeUsageForTerminal(input.accumulatedUsage, input.result.usage)
    context.deps.storage.cancelRun({
      runId: input.loopInput.runId,
      completedAt: context.deps.timestamp(),
      ...usageFieldsFrom(steerPendingUsage)
    })
    context.deps.emit<RunCancelledEvent>({
      type: 'run.cancelled',
      threadId: input.loopInput.thread.id,
      runId: input.loopInput.runId,
      requestMessageId: input.currentRequestMessageId
    })
    return {
      kind: 'cancelled',
      accumulatedUsage: steerPendingUsage,
      result: { kind: 'cancelled' }
    }
  }

  // Parent the steer under the completed assistant response.
  input.activeRun.requestMessageId = input.result.assistantMessageId

  const steerThread = context.deps.requireThread(input.loopInput.thread.id)
  const { userMessage } = persistSteerMessage(context.createSendChatFlowContext(), {
    content: steerInput.content,
    images: steerInput.images,
    attachments: steerInput.attachments,
    messageId: steerInput.messageId,
    runId: input.loopInput.runId,
    runState: input.activeRun,
    thread: steerThread,
    timestamp: steerInput.timestamp,
    hidden: steerInput.hidden
  })
  await markWorkspaceRestorePoint(input.activeRun, userMessage.id)

  emitThreadStateReplaced(context.createFollowUpQueueContext(), input.loopInput.thread.id)
  input.activeRun.pendingSteerInput = undefined
  input.activeRun.pendingSteerMessageId = undefined
  input.activeRun.executionPhase = 'generating'
  input.activeRun.requestMessageId = userMessage.id
  context.deps.storage.updateRunRequestMessageId(input.loopInput.runId, userMessage.id)

  return {
    kind: 'continue',
    accumulatedUsage: accumulateRunLoopUsage(input.accumulatedUsage, input.result.usage),
    carriedSnapshotTracker: input.result.snapshotTracker,
    carriedToolFailLoopSteers:
      input.result.toolFailLoopSteersInjected ?? input.carriedToolFailLoopSteers,
    currentRequestMessageId: userMessage.id,
    currentThread: context.deps.requireThread(input.loopInput.thread.id)
  }
}

async function markWorkspaceRestorePoint(runState: RunState, messageId: string): Promise<void> {
  if (!runState.snapshotTracker) {
    return
  }

  await runState.snapshotTracker.markRestorePoint(messageId)
  runState.workspaceRestorePointMessageIds ??= new Set<string>()
  runState.workspaceRestorePointMessageIds.add(messageId)
}

export function handleCancelledWithSteerResult(
  context: RunLoopSteerContext,
  input: {
    activeRun: RunState
    loopInput: ActiveRunLoopInput
    result: CancelledWithSteerRunResult
  }
): CancelledRunResult {
  const steerInput = input.activeRun.pendingSteerInput

  // If a prior safe-steer branch already consumed it, there is nothing left to persist.
  if (steerInput) {
    const steerThread = context.deps.requireThread(input.loopInput.thread.id)
    const { updatedThread, userMessage } = persistSteerMessage(
      context.createSendChatFlowContext(),
      {
        content: input.result.steerInput.content,
        images: input.result.steerInput.images,
        attachments: input.result.steerInput.attachments,
        messageId: input.result.steerInput.messageId,
        runId: input.loopInput.runId,
        runState: { ...input.activeRun, requestMessageId: input.result.stoppedMessageId },
        thread: steerThread,
        timestamp: input.result.steerInput.timestamp,
        hidden: input.result.steerInput.hidden
      }
    )
    const queuedThread: ThreadRecord = {
      ...updatedThread,
      queuedFollowUpMessageId: userMessage.id
    }
    if (steerInput.reasoningEffort !== undefined) {
      queuedThread.queuedFollowUpReasoningEffort = steerInput.reasoningEffort
    }
    context.deps.storage.updateThread(queuedThread)
    emitThreadStateReplaced(context.createFollowUpQueueContext(), input.loopInput.thread.id)
    input.activeRun.pendingSteerInput = undefined
  }

  return {
    kind: 'cancelled',
    ...(input.result.usage ? { usage: input.result.usage } : {})
  }
}
