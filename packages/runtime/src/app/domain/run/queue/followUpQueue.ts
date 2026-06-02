import type {
  BootstrapPayload,
  ComposerReasoningSelection,
  MessageRecord,
  RunCreatedEvent,
  RunModeId,
  SendChatRunTrigger,
  ThreadSnapshot,
  ThreadRecord,
  ThreadStateReplacedEvent
} from '@yachiyo/shared/protocol'
import type { ToolCallName } from '@yachiyo/shared/protocol'
import { summarizeMessageInput } from '@yachiyo/shared/messageContent'
import type { BootstrapState, RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import { createRunEventMetadata } from '../../shared/runEventMetadata.ts'
import type { StartActiveRunInput } from '../active/activeRunStart.ts'
import { withParentMessageId } from '../chat/threadMessages.ts'
import type { RunDomainDeps } from '../runTypes.ts'

interface PreparedQueuedFollowUpStart {
  createdAt: string
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  runMode: RunModeId
  runTrigger: SendChatRunTrigger
  reasoningEffort?: ComposerReasoningSelection
  requestMessageId: string
  runId: string
  thread: ThreadRecord
  draftMessagesBeforeRequest: MessageRecord[]
  userMessage: MessageRecord
  saveUserMessageOnStart: boolean
}

export interface QueuedFollowUpRequestDraft {
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  runMode: RunModeId
  runTrigger: SendChatRunTrigger
  reasoningEffort?: ComposerReasoningSelection
  userMessage: MessageRecord
}

export interface QueuedFollowUpDraft extends QueuedFollowUpRequestDraft {
  hiddenDrafts?: QueuedFollowUpRequestDraft[]
}

type QueuedFollowUpDrafts = Map<string, QueuedFollowUpDraft>

export interface FollowUpQueueContext {
  deps: RunDomainDeps
  activeRunByThread: Map<string, string>
  queuedFollowUpDrafts: Map<string, QueuedFollowUpDraft>
  isClosing: () => boolean
  startActiveRun: (input: StartActiveRunInput) => void
  startRecoveredRun: (checkpoint: RunRecoveryCheckpoint) => void
}

export function replaceQueuedFollowUpDraft(
  context: FollowUpQueueContext,
  threadId: string,
  draft: QueuedFollowUpDraft
): void {
  context.queuedFollowUpDrafts.set(threadId, cloneQueuedFollowUpDraft(draft))
}

export function projectQueuedFollowUpDraftSnapshot(
  queuedFollowUpDrafts: QueuedFollowUpDrafts,
  snapshot: ThreadSnapshot
): ThreadSnapshot {
  const draft = queuedFollowUpDrafts.get(snapshot.thread.id)
  if (!draft) {
    return snapshot
  }

  return {
    ...snapshot,
    queuedFollowUpMessages: getVisibleQueuedFollowUpDraftMessages(draft)
  }
}

export function projectQueuedFollowUpDraftsBootstrap(
  queuedFollowUpDrafts: QueuedFollowUpDrafts,
  bootstrap: BootstrapState
): BootstrapState
export function projectQueuedFollowUpDraftsBootstrap(
  queuedFollowUpDrafts: QueuedFollowUpDrafts,
  bootstrap: BootstrapPayload
): BootstrapPayload
export function projectQueuedFollowUpDraftsBootstrap<
  TBootstrap extends BootstrapState | BootstrapPayload
>(queuedFollowUpDrafts: QueuedFollowUpDrafts, bootstrap: TBootstrap): TBootstrap {
  if (queuedFollowUpDrafts.size === 0) {
    return bootstrap
  }

  const queuedFollowUpMessagesByThread = { ...bootstrap.queuedFollowUpMessagesByThread }
  for (const thread of bootstrap.threads) {
    const draft = queuedFollowUpDrafts.get(thread.id)
    if (!draft) continue
    queuedFollowUpMessagesByThread[thread.id] = getVisibleQueuedFollowUpDraftMessages(draft)
  }

  return {
    ...bootstrap,
    queuedFollowUpMessagesByThread
  }
}

function isVisibleQueuedFollowUpDraft(draft: QueuedFollowUpDraft): boolean {
  return draft.userMessage.hidden !== true
}

function getQueuedFollowUpDraftMessages(draft: QueuedFollowUpDraft): MessageRecord[] {
  return [
    ...(draft.hiddenDrafts?.map((hiddenDraft) => hiddenDraft.userMessage) ?? []),
    draft.userMessage
  ]
}

function getVisibleQueuedFollowUpDraftMessages(draft: QueuedFollowUpDraft): MessageRecord[] {
  return isVisibleQueuedFollowUpDraft(draft) ? [draft.userMessage] : []
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
    queuedFollowUpMessages: context.queuedFollowUpDrafts.has(threadId)
      ? getVisibleQueuedFollowUpDraftMessages(context.queuedFollowUpDrafts.get(threadId)!)
      : [],
    toolCalls
  })
}

export function deleteQueuedFollowUpDraft(
  context: FollowUpQueueContext,
  input: { threadId: string; messageId: string }
): ThreadSnapshot | null {
  const draft = context.queuedFollowUpDrafts.get(input.threadId)
  if (!draft || draft.userMessage.id !== input.messageId) {
    return null
  }

  const thread = context.deps.requireThread(input.threadId)
  const updatedThread: ThreadRecord = {
    ...thread,
    updatedAt: context.deps.timestamp()
  }
  const remainingHiddenDraft = createHiddenOnlyDraftAfterVisibleDelete(draft)
  if (remainingHiddenDraft) {
    context.queuedFollowUpDrafts.set(input.threadId, remainingHiddenDraft)
  } else {
    context.queuedFollowUpDrafts.delete(input.threadId)
  }
  context.deps.storage.updateThread(updatedThread)

  const snapshot: ThreadSnapshot = {
    thread: updatedThread,
    messages: context.deps.loadThreadMessages(input.threadId),
    queuedFollowUpMessages: remainingHiddenDraft
      ? getVisibleQueuedFollowUpDraftMessages(remainingHiddenDraft)
      : [],
    toolCalls: context.deps.loadThreadToolCalls(input.threadId)
  }
  context.deps.emit<ThreadStateReplacedEvent>({
    type: 'thread.state.replaced',
    threadId: input.threadId,
    thread: snapshot.thread,
    messages: snapshot.messages,
    queuedFollowUpMessages: snapshot.queuedFollowUpMessages,
    toolCalls: snapshot.toolCalls
  })

  return snapshot
}

function createHiddenOnlyDraftAfterVisibleDelete(
  draft: QueuedFollowUpDraft
): QueuedFollowUpDraft | null {
  if (draft.userMessage.hidden === true) {
    return null
  }

  const hiddenDrafts = draft.hiddenDrafts ?? []
  const promotedDraft = hiddenDrafts.at(-1)
  if (!promotedDraft) {
    return null
  }

  const remainingHiddenDrafts = hiddenDrafts.slice(0, -1).map(cloneQueuedFollowUpRequestDraft)
  return {
    ...cloneQueuedFollowUpRequestDraft(promotedDraft),
    ...(remainingHiddenDrafts.length > 0 ? { hiddenDrafts: remainingHiddenDrafts } : {})
  }
}

function cloneQueuedFollowUpRequestDraft(
  draft: QueuedFollowUpRequestDraft
): QueuedFollowUpRequestDraft {
  return {
    enabledTools: [...draft.enabledTools],
    ...(draft.enabledSkillNames !== undefined
      ? { enabledSkillNames: [...draft.enabledSkillNames] }
      : {}),
    runMode: draft.runMode,
    runTrigger: draft.runTrigger,
    ...(draft.reasoningEffort !== undefined ? { reasoningEffort: draft.reasoningEffort } : {}),
    userMessage: draft.userMessage
  }
}

function cloneQueuedFollowUpDraft(draft: QueuedFollowUpDraft): QueuedFollowUpDraft {
  return {
    ...cloneQueuedFollowUpRequestDraft(draft),
    ...(draft.hiddenDrafts
      ? { hiddenDrafts: draft.hiddenDrafts.map(cloneQueuedFollowUpRequestDraft) }
      : {})
  }
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
  const draft = context.queuedFollowUpDrafts.get(threadId)
  if (!draft) {
    return null
  }

  const timestamp = context.deps.timestamp()
  const activatedDraftMessages = reparentQueuedDraftMessages(
    getQueuedFollowUpDraftMessages(draft),
    {
      parentMessageId: thread.headMessageId,
      timestamp
    }
  )
  const activatedQueuedMessage = activatedDraftMessages.at(-1)
  if (!activatedQueuedMessage) {
    throw new Error('Queued follow-up activation did not produce a request message.')
  }

  const messageSummary = activatedQueuedMessage.hidden
    ? null
    : summarizeMessageInput(activatedQueuedMessage)
  const updatedThread: ThreadRecord = {
    ...thread,
    headMessageId: activatedQueuedMessage.id,
    ...(messageSummary ? { preview: messageSummary.slice(0, 240) } : {}),
    updatedAt: timestamp
  }
  const runId = context.deps.createId()

  return {
    createdAt: timestamp,
    enabledTools: draft.enabledTools,
    enabledSkillNames: draft.enabledSkillNames,
    runMode: draft.runMode,
    runTrigger: draft.runTrigger,
    ...(draft.reasoningEffort !== undefined ? { reasoningEffort: draft.reasoningEffort } : {}),
    requestMessageId: activatedQueuedMessage.id,
    runId,
    thread: updatedThread,
    draftMessagesBeforeRequest: activatedDraftMessages.slice(0, -1),
    userMessage: activatedQueuedMessage,
    saveUserMessageOnStart: true
  }
}

function reparentQueuedDraftMessages(
  messages: MessageRecord[],
  input: { parentMessageId?: string; timestamp: string }
): MessageRecord[] {
  let parentMessageId = input.parentMessageId
  return messages.map((message) => {
    const reparented = {
      ...withParentMessageId(message, parentMessageId),
      createdAt: input.timestamp
    }
    parentMessageId = reparented.id
    return reparented
  })
}

function activatePreparedQueuedFollowUp(
  context: FollowUpQueueContext,
  prepared: PreparedQueuedFollowUpStart,
  options: { emitThreadStateReplaced?: boolean } = {}
): void {
  if (context.isClosing() || context.activeRunByThread.has(prepared.thread.id)) {
    return
  }

  let currentThread = context.deps.requireThread(prepared.thread.id)
  for (const draftMessage of prepared.draftMessagesBeforeRequest) {
    const updatedThread: ThreadRecord = {
      ...currentThread,
      headMessageId: draftMessage.id,
      updatedAt: draftMessage.createdAt
    }
    context.deps.storage.saveThreadMessage({
      thread: currentThread,
      updatedThread,
      message: draftMessage
    })
    currentThread = updatedThread
  }
  if (!prepared.saveUserMessageOnStart) {
    context.deps.storage.updateMessage(prepared.userMessage)
  }
  context.deps.storage.startRun({
    runId: prepared.runId,
    requestMessageId: prepared.requestMessageId,
    thread: currentThread,
    updatedThread: prepared.thread,
    ...(prepared.saveUserMessageOnStart ? { userMessage: prepared.userMessage } : {}),
    createdAt: prepared.createdAt
  })
  context.queuedFollowUpDrafts.delete(prepared.thread.id)

  if (options.emitThreadStateReplaced) {
    emitThreadStateReplaced(context, prepared.thread.id)
  }

  context.deps.emit<RunCreatedEvent>({
    type: 'run.created',
    ...createRunEventMetadata({
      threadId: prepared.thread.id,
      runId: prepared.runId,
      requestMessageId: prepared.requestMessageId,
      runTrigger: prepared.runTrigger
    }),
    runMode: prepared.runMode
  })

  context.startActiveRun({
    enabledTools: prepared.enabledTools,
    enabledSkillNames: prepared.enabledSkillNames,
    runMode: prepared.runMode,
    runTrigger: prepared.runTrigger,
    reasoningEffort: prepared.reasoningEffort,
    runId: prepared.runId,
    thread: prepared.thread,
    requestMessageId: prepared.requestMessageId,
    updateHeadOnComplete: true
  })
}
