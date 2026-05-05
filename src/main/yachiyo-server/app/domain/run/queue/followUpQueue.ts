import type {
  RunCreatedEvent,
  ThreadRecord,
  ThreadStateReplacedEvent
} from '../../../../../../shared/yachiyo/protocol.ts'
import {
  normalizeSkillNames,
  type ToolCallName
} from '../../../../../../shared/yachiyo/protocol.ts'
import { summarizeMessageInput } from '../../../../../../shared/yachiyo/messageContent.ts'
import { wouldCreateParentCycle } from '../../../../../../shared/yachiyo/threadTree.ts'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import { resolveEnabledTools } from '../../config/configDomain.ts'
import type { StartActiveRunInput } from '../active/activeRunStart.ts'
import { withParentMessageId } from '../chat/threadMessages.ts'
import type { RunDomainDeps } from '../runTypes.ts'

interface PreparedQueuedFollowUpStart {
  createdAt: string
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  reasoningEffort?: ThreadRecord['queuedFollowUpReasoningEffort']
  requestMessageId: string
  runId: string
  thread: ThreadRecord
}

export interface FollowUpQueueContext {
  deps: RunDomainDeps
  activeRunByThread: Map<string, string>
  isClosing: () => boolean
  startActiveRun: (input: StartActiveRunInput) => void
  startRecoveredRun: (checkpoint: RunRecoveryCheckpoint) => void
}

export function prepareRecoveredQueuedFollowUps(context: FollowUpQueueContext): string[] {
  return context.deps.storage
    .bootstrap()
    .threads.filter((thread) => thread.queuedFollowUpMessageId)
    .map((thread) => thread.id)
}

export function prepareRecoveredRuns(context: FollowUpQueueContext): RunRecoveryCheckpoint[] {
  return context.deps.storage.listRunRecoveryCheckpoints().filter((checkpoint) => {
    if (context.activeRunByThread.has(checkpoint.threadId)) {
      return false
    }
    const run = context.deps.storage.getRun(checkpoint.runId)
    if (!run || run.status !== 'running') {
      context.deps.storage.deleteRunRecoveryCheckpoint(checkpoint.runId)
      return false
    }
    return true
  })
}

export function scheduleRecoveredQueuedFollowUps(
  context: FollowUpQueueContext,
  threadIds: string[]
): void {
  if (threadIds.length === 0) {
    return
  }

  setTimeout(() => {
    for (const threadId of threadIds) {
      startQueuedFollowUpIfPresent(context, threadId)
    }
  }, 0)
}

export function scheduleRecoveredRuns(
  context: FollowUpQueueContext,
  checkpoints: RunRecoveryCheckpoint[]
): void {
  if (checkpoints.length === 0) {
    return
  }

  setTimeout(() => {
    for (const checkpoint of checkpoints) {
      context.startRecoveredRun(checkpoint)
    }
  }, 0)
}

export function startQueuedFollowUpIfPresent(
  context: FollowUpQueueContext,
  threadId: string
): void {
  const prepared = prepareQueuedFollowUpStart(context, threadId)
  if (!prepared) {
    return
  }

  activatePreparedQueuedFollowUp(context, prepared, {
    emitThreadStateReplaced: true
  })
}

export function emitThreadStateReplaced(context: FollowUpQueueContext, threadId: string): void {
  const thread = context.deps.requireThread(threadId)
  const messages = context.deps.loadThreadMessages(threadId)
  const toolCalls = context.deps.loadThreadToolCalls(threadId)

  context.deps.emit<ThreadStateReplacedEvent>({
    type: 'thread.state.replaced',
    threadId,
    thread,
    messages,
    toolCalls
  })
}

function prepareQueuedFollowUpStart(
  context: FollowUpQueueContext,
  threadId: string
): PreparedQueuedFollowUpStart | null {
  if (context.activeRunByThread.has(threadId)) {
    return null
  }

  const thread = context.deps.storage.getThread(threadId)
  if (!thread) {
    return null
  }
  const queuedMessageId = thread.queuedFollowUpMessageId
  if (!queuedMessageId) {
    if (
      thread.queuedFollowUpEnabledTools ||
      thread.queuedFollowUpEnabledSkillNames ||
      thread.queuedFollowUpReasoningEffort
    ) {
      const clearedThread: ThreadRecord = {
        ...thread,
        updatedAt: context.deps.timestamp()
      }
      delete clearedThread.queuedFollowUpEnabledTools
      delete clearedThread.queuedFollowUpEnabledSkillNames
      delete clearedThread.queuedFollowUpReasoningEffort
      context.deps.storage.updateThread(clearedThread)
    }
    return null
  }

  const threadMessages = context.deps.loadThreadMessages(threadId)
  const queuedMessage = threadMessages.find(
    (message) => message.id === queuedMessageId && message.role === 'user'
  )
  if (!queuedMessage) {
    const clearedThread: ThreadRecord = {
      ...thread,
      updatedAt: context.deps.timestamp()
    }
    delete clearedThread.queuedFollowUpEnabledTools
    delete clearedThread.queuedFollowUpEnabledSkillNames
    delete clearedThread.queuedFollowUpReasoningEffort
    delete clearedThread.queuedFollowUpMessageId

    context.deps.storage.updateThread(clearedThread)
    return null
  }

  const wouldCycleQueuedFollowUpParent = wouldCreateParentCycle(
    threadMessages,
    queuedMessage.id,
    thread.headMessageId
  )
  if (wouldCycleQueuedFollowUpParent) {
    console.warn('[yachiyo][thread-tree] skipped cyclic queued follow-up reparent', {
      messageId: queuedMessage.id,
      threadHeadMessageId: thread.headMessageId,
      threadId
    })
  }
  const nextQueuedParentMessageId = wouldCycleQueuedFollowUpParent
    ? queuedMessage.parentMessageId
    : thread.headMessageId
  const reparentedQueuedMessage = withParentMessageId(queuedMessage, nextQueuedParentMessageId)
  if (reparentedQueuedMessage.parentMessageId !== queuedMessage.parentMessageId) {
    context.deps.storage.updateMessage(reparentedQueuedMessage)
  }

  const timestamp = context.deps.timestamp()
  const messageSummary = summarizeMessageInput(reparentedQueuedMessage)
  const updatedThread: ThreadRecord = {
    ...thread,
    headMessageId: queuedMessage.id,
    ...(messageSummary ? { preview: messageSummary.slice(0, 240) } : {}),
    updatedAt: timestamp
  }
  delete updatedThread.queuedFollowUpEnabledTools
  delete updatedThread.queuedFollowUpEnabledSkillNames
  delete updatedThread.queuedFollowUpReasoningEffort
  delete updatedThread.queuedFollowUpMessageId

  context.deps.storage.updateThread(updatedThread)
  const reasoningEffort = thread.queuedFollowUpReasoningEffort

  const enabledTools = thread.queuedFollowUpEnabledTools
    ? [...thread.queuedFollowUpEnabledTools]
    : resolveEnabledTools(undefined, context.deps.readConfig().enabledTools)
  const enabledSkillNames =
    thread.queuedFollowUpEnabledSkillNames === undefined
      ? undefined
      : normalizeSkillNames(thread.queuedFollowUpEnabledSkillNames)
  const runId = context.deps.createId()

  return {
    createdAt: timestamp,
    enabledTools,
    enabledSkillNames,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    requestMessageId: queuedMessage.id,
    runId,
    thread: updatedThread
  }
}

function activatePreparedQueuedFollowUp(
  context: FollowUpQueueContext,
  prepared: PreparedQueuedFollowUpStart,
  options: { emitThreadStateReplaced?: boolean } = {}
): void {
  if (context.isClosing() || context.activeRunByThread.has(prepared.thread.id)) {
    return
  }

  const currentThread = context.deps.requireThread(prepared.thread.id)
  context.deps.storage.startRun({
    runId: prepared.runId,
    requestMessageId: prepared.requestMessageId,
    thread: currentThread,
    updatedThread: prepared.thread,
    createdAt: prepared.createdAt
  })

  if (options.emitThreadStateReplaced) {
    emitThreadStateReplaced(context, prepared.thread.id)
  }

  context.deps.emit<RunCreatedEvent>({
    type: 'run.created',
    threadId: prepared.thread.id,
    runId: prepared.runId,
    requestMessageId: prepared.requestMessageId
  })

  context.startActiveRun({
    enabledTools: prepared.enabledTools,
    enabledSkillNames: prepared.enabledSkillNames,
    reasoningEffort: prepared.reasoningEffort,
    runId: prepared.runId,
    thread: prepared.thread,
    requestMessageId: prepared.requestMessageId,
    updateHeadOnComplete: true
  })
}
