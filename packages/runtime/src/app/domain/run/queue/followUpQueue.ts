import type {
  BootstrapPayload,
  MessageRecord,
  RunCreatedEvent,
  RunModeId,
  SendChatRunTrigger,
  ThreadSnapshot,
  ThreadRecord,
  ThreadStateReplacedEvent
} from '@yachiyo/shared/protocol'
import {
  DEFAULT_RUN_MODE_ID,
  normalizeSkillNames,
  type ToolCallName
} from '@yachiyo/shared/protocol'
import { summarizeMessageInput } from '@yachiyo/shared/messageContent'
import { wouldCreateParentCycle } from '@yachiyo/shared/threadTree'
import type { BootstrapState, RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import {
  deriveRunModeId,
  normalizeRunModeId,
  resolveRunModeEnabledTools
} from '@yachiyo/shared/toolModes'
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
  reasoningEffort?: ThreadRecord['queuedFollowUpReasoningEffort']
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
  reasoningEffort?: ThreadRecord['queuedFollowUpReasoningEffort']
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

export function prepareRecoveredQueuedFollowUps(context: FollowUpQueueContext): string[] {
  const recoveredThreadIds: string[] = []

  for (const thread of context.deps.storage.bootstrap().threads) {
    const queuedMessageId = thread.queuedFollowUpMessageId
    if (!queuedMessageId) {
      continue
    }

    if (context.activeRunByThread.has(thread.id) || context.queuedFollowUpDrafts.has(thread.id)) {
      continue
    }

    const hasPersistedQueuedMessage = context.deps
      .loadThreadMessages(thread.id)
      .some((message) => message.id === queuedMessageId && message.role === 'user')

    if (hasPersistedQueuedMessage) {
      recoveredThreadIds.push(thread.id)
      continue
    }

    const clearedThread: ThreadRecord = {
      ...thread,
      updatedAt: context.deps.timestamp()
    }
    delete clearedThread.queuedFollowUpEnabledTools
    delete clearedThread.queuedFollowUpEnabledSkillNames
    delete clearedThread.queuedFollowUpReasoningEffort
    delete clearedThread.queuedFollowUpMessageId
    context.deps.storage.updateThread(clearedThread)
  }

  return recoveredThreadIds
}

export function projectQueuedFollowUpDraftThread(
  queuedFollowUpDrafts: QueuedFollowUpDrafts,
  thread: ThreadRecord
): ThreadRecord {
  const draft = queuedFollowUpDrafts.get(thread.id)
  if (!draft) {
    return thread
  }
  if (!isVisibleQueuedFollowUpDraft(draft)) {
    return withoutQueuedFollowUpProjection(thread)
  }

  const projectedThread: ThreadRecord = {
    ...thread,
    queuedFollowUpEnabledTools: [...draft.enabledTools],
    queuedFollowUpMessageId: draft.userMessage.id
  }

  if (draft.enabledSkillNames !== undefined) {
    projectedThread.queuedFollowUpEnabledSkillNames = [...draft.enabledSkillNames]
  } else {
    delete projectedThread.queuedFollowUpEnabledSkillNames
  }

  if (draft.reasoningEffort !== undefined) {
    projectedThread.queuedFollowUpReasoningEffort = draft.reasoningEffort
  } else {
    delete projectedThread.queuedFollowUpReasoningEffort
  }

  return projectedThread
}

export function projectQueuedFollowUpDraftSnapshot(
  queuedFollowUpDrafts: QueuedFollowUpDrafts,
  snapshot: ThreadSnapshot
): ThreadSnapshot {
  const draft = queuedFollowUpDrafts.get(snapshot.thread.id)
  if (!draft) {
    return snapshot
  }
  if (!isVisibleQueuedFollowUpDraft(draft)) {
    return {
      ...snapshot,
      thread: withoutQueuedFollowUpProjection(snapshot.thread)
    }
  }

  return {
    ...snapshot,
    thread: projectQueuedFollowUpDraftThread(queuedFollowUpDrafts, snapshot.thread),
    messages: includeQueuedFollowUpDraftMessages(snapshot.messages, draft)
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

  const messagesByThread = { ...bootstrap.messagesByThread }
  const threads = bootstrap.threads.map((thread) => {
    const draft = queuedFollowUpDrafts.get(thread.id)
    if (!draft) {
      return thread
    }
    if (!isVisibleQueuedFollowUpDraft(draft)) {
      return withoutQueuedFollowUpProjection(thread)
    }

    messagesByThread[thread.id] = includeQueuedFollowUpDraftMessages(
      messagesByThread[thread.id] ?? [],
      draft
    )
    return projectQueuedFollowUpDraftThread(queuedFollowUpDrafts, thread)
  })

  return {
    ...bootstrap,
    threads,
    messagesByThread
  }
}

function isVisibleQueuedFollowUpDraft(draft: QueuedFollowUpDraft): boolean {
  return draft.userMessage.hidden !== true
}

function withoutQueuedFollowUpProjection(thread: ThreadRecord): ThreadRecord {
  const projectedThread = {
    ...thread
  }
  delete projectedThread.queuedFollowUpEnabledTools
  delete projectedThread.queuedFollowUpEnabledSkillNames
  delete projectedThread.queuedFollowUpReasoningEffort
  delete projectedThread.queuedFollowUpMessageId
  return projectedThread
}

function getQueuedFollowUpDraftMessages(draft: QueuedFollowUpDraft): MessageRecord[] {
  return [
    ...(draft.hiddenDrafts?.map((hiddenDraft) => hiddenDraft.userMessage) ?? []),
    draft.userMessage
  ]
}

function includeQueuedFollowUpDraftMessages(
  messages: MessageRecord[],
  draft: QueuedFollowUpDraft
): MessageRecord[] {
  const nextMessages = [...messages]
  for (const draftMessage of getQueuedFollowUpDraftMessages(draft)) {
    if (!nextMessages.some((message) => message.id === draftMessage.id)) {
      nextMessages.push(draftMessage)
    }
  }
  return nextMessages
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
  delete updatedThread.queuedFollowUpEnabledTools
  delete updatedThread.queuedFollowUpEnabledSkillNames
  delete updatedThread.queuedFollowUpReasoningEffort
  delete updatedThread.queuedFollowUpMessageId

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
    toolCalls: context.deps.loadThreadToolCalls(input.threadId)
  }
  context.deps.emit<ThreadStateReplacedEvent>({
    type: 'thread.state.replaced',
    threadId: input.threadId,
    thread: snapshot.thread,
    messages: snapshot.messages,
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
  const queuedMessageId = draft?.userMessage.id ?? thread.queuedFollowUpMessageId
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
  const queuedDraftMessage =
    draft && draft.userMessage.id === queuedMessageId ? draft.userMessage : null
  const persistedQueuedMessage = threadMessages.find(
    (message) => message.id === queuedMessageId && message.role === 'user'
  )
  if (!queuedDraftMessage && !persistedQueuedMessage) {
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

  const timestamp = context.deps.timestamp()
  const queuedMessage = queuedDraftMessage ?? persistedQueuedMessage!
  const wouldCycleQueuedFollowUpParent = persistedQueuedMessage
    ? wouldCreateParentCycle(threadMessages, queuedMessage.id, thread.headMessageId)
    : false
  if (wouldCycleQueuedFollowUpParent) {
    console.warn('[yachiyo][thread-tree] skipped cyclic queued follow-up reparent', {
      messageId: queuedMessage.id,
      threadHeadMessageId: thread.headMessageId,
      threadId
    })
  }
  const nextQueuedParentMessageId =
    persistedQueuedMessage && wouldCycleQueuedFollowUpParent
      ? queuedMessage.parentMessageId
      : thread.headMessageId
  const activatedDraftMessages = queuedDraftMessage
    ? reparentQueuedDraftMessages(getQueuedFollowUpDraftMessages(draft!), {
        parentMessageId: nextQueuedParentMessageId,
        timestamp
      })
    : [
        {
          ...withParentMessageId(queuedMessage, nextQueuedParentMessageId),
          createdAt: timestamp
        }
      ]
  const activatedQueuedMessage = activatedDraftMessages.at(-1)
  if (!activatedQueuedMessage) {
    throw new Error('Queued follow-up activation did not produce a request message.')
  }

  const messageSummary = activatedQueuedMessage.hidden
    ? null
    : summarizeMessageInput(activatedQueuedMessage)
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

  const reasoningEffort = draft?.reasoningEffort ?? thread.queuedFollowUpReasoningEffort
  const runTrigger = draft?.runTrigger ?? 'local'

  const storedRunMode =
    draft?.runMode ??
    (thread.queuedFollowUpEnabledTools
      ? deriveRunModeId(thread.queuedFollowUpEnabledTools)
      : (thread.runMode ?? DEFAULT_RUN_MODE_ID))
  const runMode = normalizeRunModeId(storedRunMode)
  const enabledTools = resolveRunModeEnabledTools(runMode)
  const enabledSkillNames = draft
    ? draft.enabledSkillNames
    : thread.queuedFollowUpEnabledSkillNames === undefined
      ? undefined
      : normalizeSkillNames(thread.queuedFollowUpEnabledSkillNames)
  const runId = context.deps.createId()

  return {
    createdAt: timestamp,
    enabledTools,
    enabledSkillNames,
    runMode,
    runTrigger,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    requestMessageId: queuedMessage.id,
    runId,
    thread: updatedThread,
    draftMessagesBeforeRequest: queuedDraftMessage ? activatedDraftMessages.slice(0, -1) : [],
    userMessage: activatedQueuedMessage,
    saveUserMessageOnStart: queuedDraftMessage != null
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
