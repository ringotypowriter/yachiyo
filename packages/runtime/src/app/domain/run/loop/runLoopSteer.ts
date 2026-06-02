import type { MessageRecord, RunCancelledEvent, ThreadRecord } from '@yachiyo/shared/protocol'
import type { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import type { ActiveRunLoopInput } from '../active/activeRunStart.ts'
import {
  clearPendingSteerInputs,
  getPendingSteerInputsForPersistence
} from '../active/pendingSteerQueue.ts'
import { persistSteerMessages, type SendChatFlowContext } from '../chat/sendChatFlow.ts'
import type { ExecuteRunInput, ExecuteRunResult } from '../execution/runExecutionTypes.ts'
import { usageFieldsFrom } from '../runUsageFields.ts'
import type { PendingSteerInput, RunDomainDeps, RunState } from '../runTypes.ts'
import {
  emitThreadStateReplaced,
  replaceQueuedFollowUpDraft,
  type FollowUpQueueContext,
  type QueuedFollowUpDraft,
  type QueuedFollowUpRequestDraft
} from '../queue/followUpQueue.ts'
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
  const steerInputs = getPendingSteerInputsForPersistence(input.activeRun)
  const snapshotTracker = input.result.snapshotTracker ?? input.activeRun.snapshotTracker

  if (steerInputs.length === 0) {
    // The steer was withdrawn after execution finished at a safe turn boundary.
    snapshotTracker?.dispose()
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
  const { userMessages } = persistSteerMessages(context.createSendChatFlowContext(), {
    steerInputs,
    runId: input.loopInput.runId,
    runState: input.activeRun,
    thread: steerThread
  })
  const requestMessage = userMessages.at(-1)
  if (!requestMessage) {
    throw new Error('Pending steer persistence did not create a request message.')
  }
  await markWorkspaceRestorePoint(input.activeRun, requestMessage.id)

  emitThreadStateReplaced(context.createFollowUpQueueContext(), input.loopInput.thread.id)
  clearPendingSteerInputs(input.activeRun)
  input.activeRun.executionPhase = 'generating'
  input.activeRun.requestMessageId = requestMessage.id
  context.deps.storage.updateRunRequestMessageId(input.loopInput.runId, requestMessage.id)

  return {
    kind: 'continue',
    accumulatedUsage: accumulateRunLoopUsage(input.accumulatedUsage, input.result.usage),
    carriedSnapshotTracker: snapshotTracker,
    carriedToolFailLoopSteers:
      input.result.toolFailLoopSteersInjected ?? input.carriedToolFailLoopSteers,
    currentRequestMessageId: requestMessage.id,
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
  const steerInputs = getPendingSteerInputsForPersistence(input.activeRun)

  // If a prior safe-steer branch already consumed it, there is nothing left to persist.
  if (steerInputs.length > 0) {
    replaceQueuedFollowUpDraft(
      context.createFollowUpQueueContext(),
      input.loopInput.thread.id,
      createQueuedFollowUpDraftFromSteers({
        activeRun: input.activeRun,
        loopInput: input.loopInput,
        parentMessageId: input.result.stoppedMessageId,
        steerInputs
      })
    )
    emitThreadStateReplaced(context.createFollowUpQueueContext(), input.loopInput.thread.id)
    clearPendingSteerInputs(input.activeRun)
  }

  return {
    kind: 'cancelled',
    ...(input.result.usage ? { usage: input.result.usage } : {})
  }
}

function createQueuedFollowUpDraftFromSteers(input: {
  activeRun: RunState
  loopInput: ActiveRunLoopInput
  parentMessageId: string
  steerInputs: PendingSteerInput[]
}): QueuedFollowUpDraft {
  const drafts = input.steerInputs.map((steerInput) =>
    createQueuedFollowUpRequestDraftFromSteer({
      activeRun: input.activeRun,
      loopInput: input.loopInput,
      parentMessageId: input.parentMessageId,
      steerInput
    })
  )
  const visibleDraftIndex = drafts.findLastIndex((draft) => draft.userMessage.hidden !== true)
  const userMessageIndex = visibleDraftIndex >= 0 ? visibleDraftIndex : drafts.length - 1
  const userDraft = drafts[userMessageIndex]

  if (!userDraft) {
    throw new Error('Pending steer queue did not create a follow-up draft.')
  }

  const hiddenDrafts = drafts.filter((_, index) => index !== userMessageIndex)

  return {
    ...userDraft,
    ...(hiddenDrafts.length > 0 ? { hiddenDrafts } : {})
  }
}

function createQueuedFollowUpRequestDraftFromSteer(input: {
  activeRun: RunState
  loopInput: ActiveRunLoopInput
  parentMessageId: string
  steerInput: PendingSteerInput
}): QueuedFollowUpRequestDraft {
  const { activeRun, loopInput, parentMessageId, steerInput } = input
  const enabledTools = steerInput.enabledTools ?? activeRun.enabledTools ?? loopInput.enabledTools
  const enabledSkillNames =
    steerInput.enabledSkillNames ?? activeRun.enabledSkillNames ?? loopInput.enabledSkillNames
  const runMode = steerInput.runMode ?? activeRun.runMode ?? loopInput.runMode
  const runTrigger = steerInput.runTrigger ?? activeRun.runTrigger ?? loopInput.runTrigger
  const reasoningEffort =
    steerInput.reasoningEffort ?? activeRun.reasoningEffort ?? loopInput.reasoningEffort
  const userMessage: MessageRecord = {
    id: steerInput.messageId,
    threadId: loopInput.thread.id,
    parentMessageId,
    role: 'user',
    content: steerInput.content,
    ...(steerInput.images && steerInput.images.length > 0 ? { images: steerInput.images } : {}),
    ...(steerInput.attachments.length > 0 ? { attachments: steerInput.attachments } : {}),
    ...(steerInput.hidden === true
      ? { hidden: true, turnContext: { hiddenRequestKind: 'follow-up' as const } }
      : {}),
    status: 'completed',
    createdAt: steerInput.timestamp
  }

  return {
    enabledTools: [...enabledTools],
    ...(enabledSkillNames !== undefined ? { enabledSkillNames: [...enabledSkillNames] } : {}),
    runMode,
    runTrigger,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    userMessage
  }
}
