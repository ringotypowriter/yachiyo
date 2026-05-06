import { resolve } from 'node:path'
import type { ToolSet } from 'ai'

import type {
  ChatAccepted,
  ComposerReasoningSelection,
  MessageCompletedEvent,
  MessageFileAttachment,
  MessageRecord,
  RunCreatedEvent,
  SendChatInput,
  SendChatMode,
  SendChatRunTrigger,
  ThreadRecord,
  ThreadUpdatedEvent,
  ToolCallName
} from '../../../../../../shared/yachiyo/protocol.ts'
import { normalizeSkillNames } from '../../../../../../shared/yachiyo/protocol.ts'
import {
  hasMessagePayload,
  normalizeMessageImages,
  summarizeMessageInput
} from '../../../../../../shared/yachiyo/messageContent.ts'
import {
  saveFileAttachmentsToWorkspace,
  saveImageFilesToWorkspace
} from '../../attachments/attachmentDomain.ts'
import { assertSupportedImages, resolveEnabledTools } from '../../config/configDomain.ts'
import { DEFAULT_THREAD_TITLE } from '../../shared/shared.ts'
import { buildTitleQuery, deriveThreadTitleFallback } from '../../threads/threadTitle.ts'
import type { RunDomainDeps, RunState } from '../runTypes.ts'
import type { QueuedFollowUpDraft } from '../queue/followUpQueue.ts'
import type { ThreadTitleGenerationRunner } from '../title/threadTitleGeneration.ts'
import {
  createDebouncedSendChatKey,
  SEND_CHAT_DEBOUNCE_WINDOW_MS,
  type DebouncedSendChatEntry
} from './sendChatDebounce.ts'

interface StartActiveRunInput {
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  reasoningEffort?: ComposerReasoningSelection
  channelHint?: string
  extraTools?: ToolSet
  runTrigger: SendChatRunTrigger
  runId: string
  thread: ThreadRecord
  requestMessageId: string
  updateHeadOnComplete: boolean
}

export interface SendChatFlowContext {
  deps: RunDomainDeps
  activeRuns: Map<string, RunState>
  activeRunByThread: Map<string, string>
  debouncedSendChats: Map<string, DebouncedSendChatEntry>
  queuedFollowUpDrafts: Map<string, QueuedFollowUpDraft>
  threadTitleRunner: ThreadTitleGenerationRunner
  startActiveRun: (input: StartActiveRunInput) => void
}

export async function sendChatFlow(
  context: SendChatFlowContext,
  input: SendChatInput
): Promise<ChatAccepted> {
  const { deps } = context
  const rawContent = input.content.trim()
  const images = normalizeMessageImages(input.images)
  const enabledTools = resolveEnabledTools(input.enabledTools, deps.readConfig().enabledTools)
  const enabledSkillNames =
    input.enabledSkillNames === undefined ? undefined : normalizeSkillNames(input.enabledSkillNames)

  const thread = deps.requireThread(input.threadId)
  const reasoningEffort = input.reasoningEffort ?? thread.reasoningEffort
  const content = rawContent
  const rawMode = input.mode ?? 'normal'
  // ACP threads do not support steer; any steer is treated as follow-up instead.
  const mode: SendChatMode =
    rawMode === 'steer' && thread.runtimeBinding?.kind === 'acp' ? 'follow-up' : rawMode
  const runTrigger = input.runTrigger ?? 'local'
  const debounceKey = createDebouncedSendChatKey({
    attachments: input.attachments,
    channelHint: input.channelHint,
    content,
    enabledSkillNames,
    enabledTools,
    extraTools: input.extraTools,
    images,
    mode,
    reasoningEffort,
    runTrigger,
    threadId: thread.id
  })

  return runDebouncedSendChat(context, debounceKey, thread.id, async () => {
    if (!hasMessagePayload({ content, images, attachments: input.attachments })) {
      throw new Error('Cannot send an empty message.')
    }
    assertSupportedImages(images)

    const messageId = deps.createId()
    const hasFiles = images.length > 0 || (input.attachments?.length ?? 0) > 0

    const workspacePath = hasFiles
      ? thread.workspacePath?.trim()
        ? resolve(thread.workspacePath)
        : await deps.ensureThreadWorkspace(thread.id)
      : null

    const enrichedImages =
      images.length > 0 && workspacePath
        ? await saveImageFilesToWorkspace({ workspacePath, messageId, images })
        : images

    const fileAttachments =
      (input.attachments?.length ?? 0) > 0 && workspacePath
        ? await saveFileAttachmentsToWorkspace({
            workspacePath,
            messageId,
            attachments: input.attachments!
          })
        : []

    let activeRunId = context.activeRunByThread.get(thread.id)

    if (activeRunId) {
      const activeRun = context.activeRuns.get(activeRunId)
      if (activeRun?.recap) {
        activeRun.abortController.abort()
        activeRunId = undefined
      }
    }

    if (!activeRunId) {
      return startFreshRun(context, {
        content,
        enabledTools,
        enabledSkillNames,
        channelHint: input.channelHint,
        extraTools: input.extraTools as ToolSet | undefined,
        runTrigger,
        reasoningEffort,
        images: enrichedImages,
        attachments: fileAttachments,
        messageId,
        thread
      })
    }

    if (mode === 'steer') {
      const activeRun = context.activeRuns.get(activeRunId)
      if (!activeRun?.requestMessageId) {
        throw new Error('Wait for the handoff to finish before sending a new message.')
      }
      // Race guard: stop was already clicked, but the tool's long-running
      // interval hasn't observed the abort yet. Writing pendingSteerInput now
      // would attach it to a run heading down the plain-cancelled path, where
      // it gets wiped when activeRuns is cleared. Route the steer through the
      // follow-up queue so startQueuedFollowUpIfPresent picks it up.
      if (activeRun.abortController.signal.aborted) {
        return queueFollowUp(context, {
          content,
          enabledTools,
          enabledSkillNames,
          runTrigger,
          reasoningEffort,
          images: enrichedImages,
          attachments: fileAttachments,
          messageId,
          thread
        })
      }
      return sendActiveRunSteer(context, {
        activeRunId,
        content,
        enabledSkillNames,
        runTrigger,
        reasoningEffort,
        images: enrichedImages,
        attachments: fileAttachments,
        messageId,
        thread
      })
    }

    if (mode === 'follow-up') {
      if (!context.activeRuns.get(activeRunId)?.requestMessageId) {
        throw new Error('Wait for the handoff to finish before sending a new message.')
      }
      return queueFollowUp(context, {
        content,
        enabledTools,
        enabledSkillNames,
        runTrigger,
        reasoningEffort,
        images: enrichedImages,
        attachments: fileAttachments,
        messageId,
        thread
      })
    }

    throw new Error('This thread already has an active run.')
  })
}

function startFreshRun(
  context: SendChatFlowContext,
  input: {
    content: string
    enabledTools: ToolCallName[]
    enabledSkillNames?: string[]
    reasoningEffort?: ComposerReasoningSelection
    channelHint?: string
    extraTools?: ToolSet
    runTrigger: SendChatRunTrigger
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    thread: ThreadRecord
    /** When true, the user message is hidden from the chat timeline (system-initiated). */
    hidden?: boolean
    /** Override the parent message for the new user message (defaults to thread.headMessageId). */
    parentMessageId?: string
  }
): ChatAccepted {
  const { deps } = context
  const timestamp = deps.timestamp()
  const messageSummary = input.hidden
    ? null
    : summarizeMessageInput({
        content: input.content,
        images: input.images
      })
  const fallbackTitle =
    !input.hidden && input.thread.title === DEFAULT_THREAD_TITLE
      ? deriveThreadTitleFallback({
          content: input.content,
          ...(input.images ? { images: input.images } : {})
        }) || DEFAULT_THREAD_TITLE
      : null
  const userMessage = createUserMessage({
    id: input.messageId,
    content: input.content,
    images: input.images,
    attachments: input.attachments,
    parentMessageId: input.parentMessageId ?? input.thread.headMessageId,
    threadId: input.thread.id,
    timestamp,
    hidden: input.hidden
  })
  const threadWithoutRecap = { ...input.thread }
  if (!input.hidden) delete threadWithoutRecap.recapText
  const updatedThread: ThreadRecord = {
    ...threadWithoutRecap,
    headMessageId: userMessage.id,
    ...(messageSummary ? { preview: messageSummary.slice(0, 240) } : {}),
    title: fallbackTitle ?? input.thread.title,
    updatedAt: timestamp
  }
  const accepted: ChatAccepted = {
    kind: 'run-started',
    runId: deps.createId(),
    thread: updatedThread,
    userMessage
  }

  deps.storage.startRun({
    runId: accepted.runId,
    requestMessageId: userMessage.id,
    thread: input.thread,
    updatedThread,
    userMessage,
    createdAt: timestamp
  })

  deps.emit<ThreadUpdatedEvent>({
    type: 'thread.updated',
    threadId: accepted.thread.id,
    thread: accepted.thread
  })
  // Emit user message so the renderer can display it in real-time
  // (especially important for external/channel threads where sendChat is
  // called server-side and the renderer doesn't receive the IPC response).
  deps.emit<MessageCompletedEvent>({
    type: 'message.completed',
    threadId: accepted.thread.id,
    runId: accepted.runId,
    message: userMessage
  })
  deps.emit<RunCreatedEvent>({
    type: 'run.created',
    threadId: accepted.thread.id,
    runId: accepted.runId,
    requestMessageId: userMessage.id
  })

  if (!input.hidden && fallbackTitle && fallbackTitle !== DEFAULT_THREAD_TITLE && input.content) {
    context.threadTitleRunner.schedule({
      fallbackTitle,
      query: buildTitleQuery(input.content, input.images, input.attachments),
      runId: accepted.runId,
      threadId: accepted.thread.id
    })
  }

  context.startActiveRun({
    enabledTools: input.enabledTools,
    enabledSkillNames: input.enabledSkillNames,
    channelHint: input.channelHint,
    extraTools: input.extraTools,
    runTrigger: input.runTrigger,
    reasoningEffort: input.reasoningEffort,
    runId: accepted.runId,
    thread: accepted.thread,
    requestMessageId: userMessage.id,
    updateHeadOnComplete: true
  })

  return accepted
}

export function sendActiveRunSteer(
  context: SendChatFlowContext,
  input: {
    activeRunId: string
    content: string
    enabledSkillNames?: string[]
    runTrigger: SendChatRunTrigger
    reasoningEffort?: ComposerReasoningSelection
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    thread: ThreadRecord
    hidden?: boolean
  }
): ChatAccepted {
  const activeRun = context.activeRuns.get(input.activeRunId)
  if (!activeRun) {
    throw new Error('This thread no longer has an active run.')
  }

  // Always queue the steer - it will be applied at the next turn boundary
  // (step boundary via stopWhen, or after the assistant message completes).
  // Never abort the current generation for a steer.
  const previousEnabledSkillNames = activeRun.enabledSkillNames
  const previousReasoningEffort = activeRun.reasoningEffort
  const previousRunTrigger = activeRun.runTrigger
  activeRun.enabledSkillNames = input.enabledSkillNames ? [...input.enabledSkillNames] : undefined
  activeRun.runTrigger = input.runTrigger
  if (input.reasoningEffort !== undefined) {
    activeRun.reasoningEffort = input.reasoningEffort
  }

  if (activeRun.pendingSteerInput) {
    activeRun.pendingSteerInput = {
      content: [activeRun.pendingSteerInput.content, input.content]
        .filter((part) => part.length > 0)
        .join('\n'),
      images: [...(activeRun.pendingSteerInput.images ?? []), ...(input.images ?? [])],
      attachments: [...activeRun.pendingSteerInput.attachments, ...(input.attachments ?? [])],
      messageId: activeRun.pendingSteerInput.messageId,
      timestamp: activeRun.pendingSteerInput.timestamp,
      previousEnabledSkillNames: activeRun.pendingSteerInput.previousEnabledSkillNames,
      previousReasoningEffort: activeRun.pendingSteerInput.previousReasoningEffort,
      previousRunTrigger: activeRun.pendingSteerInput.previousRunTrigger,
      reasoningEffort: input.reasoningEffort ?? activeRun.pendingSteerInput.reasoningEffort,
      hidden: activeRun.pendingSteerInput.hidden
    }
  } else {
    activeRun.pendingSteerInput = {
      content: input.content,
      images: input.images,
      attachments: input.attachments,
      messageId: input.messageId,
      timestamp: context.deps.timestamp(),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      previousEnabledSkillNames,
      ...(previousReasoningEffort !== undefined ? { previousReasoningEffort } : {}),
      ...(previousRunTrigger !== undefined ? { previousRunTrigger } : {}),
      hidden: input.hidden
    }
  }

  return {
    kind: 'active-run-steer-pending',
    runId: input.activeRunId,
    thread: input.thread
  }
}

function queueFollowUp(
  context: SendChatFlowContext,
  input: {
    content: string
    enabledTools: ToolCallName[]
    enabledSkillNames?: string[]
    runTrigger: SendChatRunTrigger
    reasoningEffort?: ComposerReasoningSelection
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    thread: ThreadRecord
  }
): ChatAccepted {
  const { deps } = context
  const activeRunId = context.activeRunByThread.get(input.thread.id)
  const activeRun = activeRunId ? context.activeRuns.get(activeRunId) : null
  if (!activeRunId || !activeRun) {
    return startFreshRun(context, input)
  }

  const timestamp = deps.timestamp()
  const previousQueuedDraft = context.queuedFollowUpDrafts.get(input.thread.id)
  const replacedMessageId = previousQueuedDraft?.userMessage.id
  const mergedContent = previousQueuedDraft
    ? [previousQueuedDraft.userMessage.content, input.content]
        .filter((part) => part.length > 0)
        .join('\n')
    : input.content
  const mergedImages = previousQueuedDraft
    ? [...(previousQueuedDraft.userMessage.images ?? []), ...(input.images ?? [])]
    : input.images
  const mergedAttachments = previousQueuedDraft
    ? [...(previousQueuedDraft.userMessage.attachments ?? []), ...input.attachments]
    : input.attachments
  const userMessage = createUserMessage({
    id: input.messageId,
    content: mergedContent,
    images: mergedImages,
    attachments: mergedAttachments,
    parentMessageId: activeRun.pendingSteerMessageId ?? activeRun.requestMessageId,
    threadId: input.thread.id,
    timestamp
  })
  const updatedThread: ThreadRecord = {
    ...input.thread,
    queuedFollowUpEnabledTools: [...input.enabledTools],
    queuedFollowUpMessageId: userMessage.id,
    updatedAt: timestamp
  }
  if (input.reasoningEffort !== undefined) {
    updatedThread.queuedFollowUpReasoningEffort = input.reasoningEffort
  } else {
    delete updatedThread.queuedFollowUpReasoningEffort
  }
  if (input.enabledSkillNames !== undefined) {
    updatedThread.queuedFollowUpEnabledSkillNames = [...input.enabledSkillNames]
  } else {
    delete updatedThread.queuedFollowUpEnabledSkillNames
  }

  context.queuedFollowUpDrafts.set(input.thread.id, {
    enabledTools: [...input.enabledTools],
    ...(input.enabledSkillNames !== undefined
      ? { enabledSkillNames: [...input.enabledSkillNames] }
      : {}),
    runTrigger: input.runTrigger,
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    userMessage
  })
  deps.emit<ThreadUpdatedEvent>({
    type: 'thread.updated',
    threadId: updatedThread.id,
    thread: updatedThread
  })
  deps.emit<MessageCompletedEvent>({
    type: 'message.completed',
    threadId: updatedThread.id,
    runId: activeRunId,
    message: userMessage
  })

  return {
    kind: 'active-run-follow-up',
    runId: activeRunId,
    thread: updatedThread,
    userMessage,
    ...(replacedMessageId ? { replacedMessageId } : {})
  }
}

function createUserMessage(input: {
  id: string
  content: string
  images: MessageRecord['images']
  attachments: MessageFileAttachment[]
  parentMessageId?: string
  threadId: string
  timestamp: string
  hidden?: boolean
}): MessageRecord {
  return {
    id: input.id,
    threadId: input.threadId,
    ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
    role: 'user',
    content: input.content,
    ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
    ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
    ...(input.hidden ? { hidden: true } : {}),
    status: 'completed',
    createdAt: input.timestamp
  }
}

function runDebouncedSendChat(
  context: SendChatFlowContext,
  debounceKey: string | null,
  threadId: string,
  execute: () => Promise<ChatAccepted>
): Promise<ChatAccepted> {
  if (!debounceKey) {
    return execute()
  }

  const nowMs = getCurrentTimestampMs(context)
  pruneExpiredDebouncedSendChats(context, nowMs)

  const existing = context.debouncedSendChats.get(debounceKey)
  if (existing && existing.expiresAt > nowMs) {
    if (existing.stateSignature) {
      const currentStateSignature = createDebouncedSendChatStateSignature(context, threadId)
      if (existing.stateSignature !== currentStateSignature) {
        context.debouncedSendChats.delete(debounceKey)
      } else {
        existing.expiresAt = nowMs + SEND_CHAT_DEBOUNCE_WINDOW_MS
        return existing.promise
      }
    } else {
      existing.expiresAt = nowMs + SEND_CHAT_DEBOUNCE_WINDOW_MS
      return existing.promise
    }
  }

  const promise = execute().catch((error) => {
    const current = context.debouncedSendChats.get(debounceKey)
    if (current?.promise === promise) {
      context.debouncedSendChats.delete(debounceKey)
    }
    throw error
  })

  context.debouncedSendChats.set(debounceKey, {
    expiresAt: nowMs + SEND_CHAT_DEBOUNCE_WINDOW_MS,
    promise
  })

  void promise.then(() => {
    const current = context.debouncedSendChats.get(debounceKey)
    if (current?.promise === promise) {
      current.stateSignature = createDebouncedSendChatStateSignature(context, threadId)
    }
  })

  return promise
}

function createDebouncedSendChatStateSignature(
  context: SendChatFlowContext,
  threadId: string
): string {
  const thread = context.deps.requireThread(threadId)
  const activeRunId = context.activeRunByThread.get(threadId) ?? null
  const activeRun = activeRunId ? context.activeRuns.get(activeRunId) : null
  const queuedFollowUpDraft = context.queuedFollowUpDrafts.get(threadId) ?? null

  return JSON.stringify({
    activeRunId,
    executionPhase: activeRun?.executionPhase ?? null,
    headMessageId: thread.headMessageId ?? null,
    pendingSteerMessageId: activeRun?.pendingSteerMessageId ?? null,
    queuedFollowUpDraft: queuedFollowUpDraft
      ? {
          content: queuedFollowUpDraft.userMessage.content,
          createdAt: queuedFollowUpDraft.userMessage.createdAt,
          enabledSkillNames: queuedFollowUpDraft.enabledSkillNames ?? null,
          enabledTools: queuedFollowUpDraft.enabledTools,
          id: queuedFollowUpDraft.userMessage.id,
          parentMessageId: queuedFollowUpDraft.userMessage.parentMessageId ?? null,
          reasoningEffort: queuedFollowUpDraft.reasoningEffort ?? null
        }
      : null,
    queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
    queuedFollowUpReasoningEffort: thread.queuedFollowUpReasoningEffort ?? null,
    requestMessageId: activeRun?.requestMessageId ?? null
  })
}

function getCurrentTimestampMs(context: SendChatFlowContext): number {
  const timestampMs = Date.parse(context.deps.timestamp())
  if (Number.isNaN(timestampMs)) {
    throw new Error('Invalid server timestamp.')
  }
  return timestampMs
}

function pruneExpiredDebouncedSendChats(context: SendChatFlowContext, nowMs: number): void {
  for (const [debounceKey, entry] of context.debouncedSendChats) {
    if (entry.expiresAt <= nowMs) {
      context.debouncedSendChats.delete(debounceKey)
    }
  }
}

export function persistSteerMessage(
  context: SendChatFlowContext,
  input: {
    content: string
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    runId: string
    runState: RunState
    thread: ThreadRecord
    timestamp: string
    hidden?: boolean
  }
): { updatedThread: ThreadRecord; userMessage: MessageRecord } {
  const { deps } = context
  const persistedAt = deps.timestamp()
  const userMessage = createUserMessage({
    id: input.messageId,
    content: input.content,
    images: input.images,
    attachments: input.attachments,
    parentMessageId: input.runState.pendingSteerMessageId ?? input.runState.requestMessageId,
    threadId: input.thread.id,
    timestamp: persistedAt,
    hidden: input.hidden
  })
  const updatedThread: ThreadRecord = {
    ...input.thread,
    headMessageId: userMessage.id,
    updatedAt: persistedAt
  }

  deps.storage.saveThreadMessage({
    thread: input.thread,
    updatedThread,
    message: userMessage
  })
  deps.emit<ThreadUpdatedEvent>({
    type: 'thread.updated',
    threadId: updatedThread.id,
    thread: updatedThread
  })
  deps.emit<MessageCompletedEvent>({
    type: 'message.completed',
    threadId: updatedThread.id,
    runId: input.runId,
    message: userMessage
  })

  return {
    updatedThread,
    userMessage
  }
}
