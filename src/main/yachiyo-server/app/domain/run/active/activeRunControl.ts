import type { RunCancelledEvent } from '../../../../../../shared/yachiyo/protocol.ts'
import type { RunDomainDeps, RunState } from '../runTypes.ts'
import {
  applyFinalPendingSteerOptions,
  clearPendingSteerInputs,
  getPendingSteerInputsForPersistence,
  hasPendingSteerInputs,
  removeVisiblePendingSteerInputs
} from './pendingSteerQueue.ts'

export interface CancelRunInput {
  runId: string
}

export interface AnswerToolQuestionInput {
  runId: string
  toolCallId: string
  answer: string
}

export interface ActiveRunControlContext {
  deps: RunDomainDeps
  activeRuns: Map<string, RunState>
  activeRunByThread: Map<string, string>
}

export function cancelRun(context: ActiveRunControlContext, input: CancelRunInput): void {
  const activeRun = context.activeRuns.get(input.runId)
  if (activeRun) {
    // If there's a pending steer, pass it through the abort reason so the
    // catch block in executeServerRun can persist the stopped assistant
    // message first, then the run loop parents the steer under it — keeping
    // the ancestor chain intact for future LLM context assembly.
    //
    // Do NOT clear pending steer state here — it must survive as a fallback
    // for race conditions where executeServerRun returns 'steer-pending'
    // (model finished before observing the abort). The steer-pending handler
    // and the cancelled-with-steer handler each clear it after persisting.
    if (hasPendingSteerInputs(activeRun)) {
      activeRun.abortController.abort({
        type: 'cancel-with-steer',
        steerInputs: getPendingSteerInputsForPersistence(activeRun)
      })
      return
    }

    activeRun.abortController.abort()
    return
  }

  const persistedRun = context.deps.storage.getRun(input.runId)
  if (!persistedRun || persistedRun.status !== 'running') {
    return
  }

  context.deps.storage.cancelRun({
    runId: input.runId,
    completedAt: context.deps.timestamp()
  })
  context.deps.emit<RunCancelledEvent>({
    type: 'run.cancelled',
    threadId: persistedRun.threadId,
    runId: input.runId
  })
}

export function cancelRunForThread(context: ActiveRunControlContext, threadId: string): boolean {
  const runId = context.activeRunByThread.get(threadId)
  if (!runId) {
    return false
  }
  cancelRun(context, { runId })
  return true
}

export function withdrawPendingSteer(context: ActiveRunControlContext, threadId: string): void {
  const runId = context.activeRunByThread.get(threadId)
  if (!runId) return
  const activeRun = context.activeRuns.get(runId)
  if (!activeRun) return
  const visibleSteer = removeVisiblePendingSteerInputs(activeRun)
  if (!visibleSteer) return
  if (hasPendingSteerInputs(activeRun)) {
    applyFinalPendingSteerOptions(activeRun)
    return
  }
  // Restore the skill override the steer replaced so the live run
  // continues with its original configuration.
  activeRun.enabledSkillNames = visibleSteer.previousEnabledSkillNames
  if (visibleSteer.previousReasoningEffort !== undefined) {
    activeRun.reasoningEffort = visibleSteer.previousReasoningEffort
  } else {
    delete activeRun.reasoningEffort
  }
  if (visibleSteer.previousRunTrigger !== undefined) {
    activeRun.runTrigger = visibleSteer.previousRunTrigger
  } else {
    delete activeRun.runTrigger
  }
  clearPendingSteerInputs(activeRun)
}

export function cancelRunForChannelUser(
  context: ActiveRunControlContext,
  channelUserId: string
): boolean {
  for (const [threadId] of context.activeRunByThread) {
    const thread = context.deps.storage.getThread(threadId)
    if (thread?.channelUserId === channelUserId) {
      return cancelRunForThread(context, threadId)
    }
  }
  return false
}

export function answerToolQuestion(
  context: ActiveRunControlContext,
  input: AnswerToolQuestionInput
): void {
  const activeRun = context.activeRuns.get(input.runId)
  if (activeRun?.answerToolQuestion) {
    activeRun.answerToolQuestion(input.toolCallId, input.answer)
  }
}
