import { readFile } from 'node:fs/promises'

import { resolve } from 'node:path'

import type {
  ChatAccepted,
  CompactThreadAccepted,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageFileAttachment,
  MessageRecord,
  MessageStartedEvent,
  ProviderSettings,
  RunCancelledEvent,
  RunCompletedEvent,
  RetryAccepted,
  RetryInput,
  RunFailedEvent,
  RunCreatedEvent,
  SendChatInput,
  SkillCatalogEntry,
  SettingsConfig,
  SubagentProgressEvent,
  ThreadRecord,
  ThreadStateReplacedEvent,
  ThreadUpdatedEvent,
  ToolCallRecord,
  ToolCallName
} from '../../../../shared/yachiyo/protocol.ts'
import { saveFileAttachmentsToWorkspace, saveImageFilesToWorkspace } from './attachmentDomain.ts'
import {
  hasMessagePayload,
  normalizeMessageImages,
  summarizeMessageInput
} from '../../../../shared/yachiyo/messageContent.ts'
import { normalizeSkillNames } from '../../../../shared/yachiyo/protocol.ts'
import type { AuxiliaryGenerationService } from '../../runtime/auxiliaryGeneration.ts'
import type { SoulDocument } from '../../runtime/soul.ts'
import type { UserDocument } from '../../runtime/user.ts'
import type { MemoryService } from '../../services/memory/memoryService.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import type { WebSearchService } from '../../services/webSearch/webSearchService.ts'
import type { BrowserWebPageSnapshotLoader } from '../../services/webRead/browserWebPageSnapshot.ts'
import type { ModelRuntime } from '../../runtime/types.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import { collectMessagePath } from '../../../../shared/yachiyo/threadTree.ts'
import { assertSupportedImages, resolveEnabledTools } from './configDomain.ts'
import { toEffectiveProviderSettings } from '../../settings/settingsStore.ts'
import { executeServerRun, type RestartRunReason, type ExecuteRunResult } from './runExecution.ts'
import {
  buildThreadTitleGenerationMessages,
  deriveThreadTitleFallback,
  parseGeneratedTitleAndIcon
} from './threadTitle.ts'
import { resolveRetryRequest } from './threadDomain.ts'
import { buildCompactThreadHandoffMessages } from '../../runtime/threadHandoff.ts'
import { buildRollingSummaryMessages } from '../../runtime/rollingSummary.ts'
import {
  DEFAULT_THREAD_TITLE,
  INTERRUPTED_RUN_ERROR,
  SHUTDOWN_RUN_ERROR,
  type CreateId,
  type EmitServerEvent,
  type Timestamp
} from './shared.ts'

interface RunState {
  threadId: string
  requestMessageId?: string
  enabledSkillNames?: string[]
  channelHint?: string
  abortController: AbortController
  pendingSteerMessageId?: string
  pendingSteerInput?: {
    content: string
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    timestamp: string
  }
  executionPhase: 'generating' | 'tool-running'
  updateHeadOnComplete: boolean
}

interface PreparedQueuedFollowUpStart {
  createdAt: string
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  requestMessageId: string
  runId: string
  thread: ThreadRecord
}

interface RunDomainDeps {
  storage: YachiyoStorage
  createId: CreateId
  timestamp: Timestamp
  emit: EmitServerEvent
  auxiliaryGeneration: AuxiliaryGenerationService
  createModelRuntime: () => ModelRuntime
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  fetchImpl?: typeof globalThis.fetch
  loadBrowserSnapshot?: BrowserWebPageSnapshotLoader
  memoryService: MemoryService
  searchService?: SearchService
  webSearchService?: WebSearchService
  readSoulDocument?: () => Promise<SoulDocument | null>
  readUserDocument?: () => Promise<UserDocument | null>
  readConfig: () => SettingsConfig
  readSettings: () => ProviderSettings
  listSkills: (workspacePaths?: string[]) => Promise<SkillCatalogEntry[]>
  requireThread: (threadId: string) => ThreadRecord
  loadThreadMessages: (threadId: string) => MessageRecord[]
  loadThreadToolCalls: (threadId: string) => ToolCallRecord[]
}

function toRestartRunReason(nextRequestMessageId: string): RestartRunReason {
  return {
    type: 'restart',
    nextRequestMessageId
  }
}

function withParentMessageId(message: MessageRecord, parentMessageId?: string): MessageRecord {
  const rest = { ...message }
  delete rest.parentMessageId

  return {
    ...rest,
    ...(parentMessageId ? { parentMessageId } : {})
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function resolveEffectiveThreadMessages(
  thread: ThreadRecord,
  messages: MessageRecord[]
): MessageRecord[] {
  if (messages.length === 0) {
    return []
  }

  const headMessageId =
    thread.headMessageId && messages.some((message) => message.id === thread.headMessageId)
      ? thread.headMessageId
      : [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
          ?.id

  if (!headMessageId) {
    return [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  return collectMessagePath(messages, headMessageId)
}

export class YachiyoServerRunDomain {
  private readonly deps: RunDomainDeps
  private readonly activeRuns = new Map<string, RunState>()
  private readonly activeRunByThread = new Map<string, string>()
  private readonly activeRunTasks = new Map<string, Promise<void>>()
  private readonly backgroundTitleTasks = new Set<Promise<void>>()
  private readonly backgroundTitleTaskControllers = new Set<AbortController>()
  private readonly backgroundMemoryTasks = new Set<Promise<void>>()
  private readonly backgroundMemoryTaskControllers = new Set<AbortController>()
  private lastRunEnabledTools: ToolCallName[] | null
  private isClosing = false

  constructor(deps: RunDomainDeps) {
    this.deps = deps
    this.lastRunEnabledTools = null
  }

  hasActiveThread(threadId: string): boolean {
    return this.activeRunByThread.has(threadId)
  }

  async close(): Promise<void> {
    this.isClosing = true

    for (const state of this.activeRuns.values()) {
      state.abortController.abort()
    }
    for (const controller of this.backgroundTitleTaskControllers.values()) {
      controller.abort()
    }
    for (const controller of this.backgroundMemoryTaskControllers.values()) {
      controller.abort()
    }

    if (this.activeRunTasks.size > 0) {
      await Promise.allSettled(this.activeRunTasks.values())
    }
    if (this.backgroundTitleTasks.size > 0) {
      await Promise.allSettled(this.backgroundTitleTasks)
    }
    if (this.backgroundMemoryTasks.size > 0) {
      await Promise.allSettled(this.backgroundMemoryTasks)
    }

    this.recoverInterruptedRuns(SHUTDOWN_RUN_ERROR)
    this.activeRuns.clear()
    this.activeRunByThread.clear()
    this.activeRunTasks.clear()
    this.backgroundTitleTaskControllers.clear()
    this.backgroundTitleTasks.clear()
    this.backgroundMemoryTaskControllers.clear()
    this.backgroundMemoryTasks.clear()
  }

  recoverInterruptedRuns(error: string = INTERRUPTED_RUN_ERROR): void {
    this.deps.storage.recoverInterruptedRuns({
      error,
      finishedAt: this.deps.timestamp()
    })
  }

  prepareRecoveredQueuedFollowUps(): string[] {
    return this.deps.storage
      .bootstrap()
      .threads.filter((thread) => thread.queuedFollowUpMessageId)
      .map((thread) => thread.id)
  }

  scheduleRecoveredQueuedFollowUps(threadIds: string[]): void {
    if (threadIds.length === 0) {
      return
    }

    setTimeout(() => {
      for (const threadId of threadIds) {
        this.startQueuedFollowUpIfPresent(threadId)
      }
    }, 0)
  }

  async expandSkillReference(content: string, workspacePaths: string[]): Promise<string> {
    const match = /^@skills:([a-zA-Z0-9_-]+)(\s|$)/.exec(content)
    if (!match) return content

    const skillName = match[1]
    const skills = await this.deps.listSkills(workspacePaths)
    const skill = skills.find((s) => s.name === skillName)
    if (!skill) return content

    const skillContent = await readFile(skill.skillFilePath, 'utf8').catch(() => '')
    const lines: string[] = [
      `Skill: ${skill.name}`,
      ...(skill.description ? [`Description: ${skill.description}`] : []),
      '',
      skillContent.trim()
    ]
    const replacement = lines.join('\n').trim()
    return content.slice(match[0].length)
      ? `${replacement}\n\n${content.slice(match[0].length)}`
      : replacement
  }

  async sendChat(input: SendChatInput): Promise<ChatAccepted> {
    const rawContent = input.content.trim()
    const images = normalizeMessageImages(input.images)
    const enabledTools = resolveEnabledTools(
      input.enabledTools,
      this.deps.readConfig().enabledTools
    )
    const enabledSkillNames =
      input.enabledSkillNames === undefined
        ? undefined
        : normalizeSkillNames(input.enabledSkillNames)

    const thread = this.deps.requireThread(input.threadId)
    const workspacePaths = thread.workspacePath ? [thread.workspacePath] : []
    const content = await this.expandSkillReference(rawContent, workspacePaths)

    if (!hasMessagePayload({ content, images, attachments: input.attachments })) {
      throw new Error('Cannot send an empty message.')
    }
    assertSupportedImages(images)

    const messageId = this.deps.createId()
    const hasFiles = images.length > 0 || (input.attachments?.length ?? 0) > 0

    const workspacePath = hasFiles
      ? thread.workspacePath?.trim()
        ? resolve(thread.workspacePath)
        : await this.deps.ensureThreadWorkspace(thread.id)
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

    const activeRunId = this.activeRunByThread.get(thread.id)
    const mode = input.mode ?? 'normal'

    if (!activeRunId) {
      return this.startFreshRun({
        content,
        enabledTools,
        enabledSkillNames,
        channelHint: input.channelHint,
        images: enrichedImages,
        attachments: fileAttachments,
        messageId,
        thread
      })
    }

    if (mode === 'steer') {
      if (!this.activeRuns.get(activeRunId)?.requestMessageId) {
        throw new Error('Wait for the handoff to finish before sending a new message.')
      }
      return this.sendActiveRunSteer({
        activeRunId,
        content,
        enabledSkillNames,
        images: enrichedImages,
        attachments: fileAttachments,
        messageId,
        thread
      })
    }

    if (mode === 'follow-up') {
      if (!this.activeRuns.get(activeRunId)?.requestMessageId) {
        throw new Error('Wait for the handoff to finish before sending a new message.')
      }
      return this.queueFollowUp({
        content,
        enabledTools,
        enabledSkillNames,
        images: enrichedImages,
        attachments: fileAttachments,
        messageId,
        thread
      })
    }

    throw new Error('This thread already has an active run.')
  }

  async retryMessage(input: RetryInput): Promise<RetryAccepted> {
    const thread = this.deps.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('This thread already has an active run.')
    }

    const enabledTools = resolveEnabledTools(
      input.enabledTools,
      this.deps.readConfig().enabledTools
    )
    const enabledSkillNames =
      input.enabledSkillNames === undefined
        ? undefined
        : normalizeSkillNames(input.enabledSkillNames)
    const messages = this.deps.loadThreadMessages(thread.id)
    const { requestMessage, sourceAssistantMessage } = resolveRetryRequest(
      thread,
      messages,
      input.messageId
    )
    const timestamp = this.deps.timestamp()
    const updatedThread: ThreadRecord = {
      ...thread,
      headMessageId: requestMessage.id,
      updatedAt: timestamp
    }
    const accepted: RetryAccepted = {
      runId: this.deps.createId(),
      thread: updatedThread,
      requestMessageId: requestMessage.id,
      ...(sourceAssistantMessage ? { sourceAssistantMessageId: sourceAssistantMessage.id } : {})
    }

    this.deps.storage.startRun({
      runId: accepted.runId,
      requestMessageId: requestMessage.id,
      thread,
      updatedThread,
      createdAt: timestamp
    })

    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: accepted.thread.id,
      thread: accepted.thread
    })
    this.deps.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: accepted.thread.id,
      runId: accepted.runId,
      requestMessageId: requestMessage.id
    })

    this.startActiveRun({
      enabledTools,
      enabledSkillNames,
      runId: accepted.runId,
      thread: accepted.thread,
      requestMessageId: requestMessage.id,
      updateHeadOnComplete: true
    })

    return accepted
  }

  async compactThreadToAnotherThread(input: {
    sourceThread: ThreadRecord
    destinationThread: ThreadRecord
  }): Promise<CompactThreadAccepted> {
    if (this.activeRunByThread.has(input.sourceThread.id)) {
      throw new Error('Cannot compact a thread with an active run.')
    }

    const runId = this.deps.createId()
    const timestamp = this.deps.timestamp()
    const sourceMessages = this.deps.loadThreadMessages(input.sourceThread.id)
    const effectiveMessages = resolveEffectiveThreadMessages(input.sourceThread, sourceMessages)

    this.deps.storage.startRun({
      runId,
      thread: input.destinationThread,
      updatedThread: input.destinationThread,
      createdAt: timestamp
    })

    this.deps.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: input.destinationThread.id,
      runId
    })

    this.startAssistantOnlyRun({
      runId,
      thread: input.destinationThread,
      sourceMessages: effectiveMessages
    })

    return {
      runId,
      sourceThreadId: input.sourceThread.id,
      thread: input.destinationThread
    }
  }

  /**
   * Generate a rolling summary for an external channel thread in-place.
   * Unlike `compactThreadToAnotherThread`, this does not create a new thread —
   * it stores the summary on the existing thread and sets a watermark so
   * subsequent runs only replay messages after the watermark.
   */
  async compactExternalThread(input: { thread: ThreadRecord }): Promise<{ thread: ThreadRecord }> {
    if (this.activeRunByThread.has(input.thread.id)) {
      throw new Error('Cannot compact a thread with an active run.')
    }

    const sourceMessages = this.deps.loadThreadMessages(input.thread.id)
    let effectiveMessages = resolveEffectiveThreadMessages(input.thread, sourceMessages)

    // On repeated compactions, only feed the prior rolling summary + messages
    // after the watermark into the model. This keeps the compaction input bounded
    // instead of growing monotonically with every compaction cycle.
    if (input.thread.summaryWatermarkMessageId) {
      const watermarkIndex = effectiveMessages.findIndex(
        (m) => m.id === input.thread.summaryWatermarkMessageId
      )
      if (watermarkIndex >= 0) {
        effectiveMessages = effectiveMessages.slice(watermarkIndex + 1)
      }
    }

    if (effectiveMessages.length === 0) {
      return { thread: input.thread }
    }

    // Respect the thread's model override so Telegram threads pinned to a
    // specific provider/model use that model for summary generation too.
    const settings = toEffectiveProviderSettings(this.deps.readConfig(), input.thread.modelOverride)
    const runtime = this.deps.createModelRuntime()
    const userDocument = this.deps.readUserDocument ? await this.deps.readUserDocument() : null

    // When re-compacting, prepend the existing rolling summary as context so the
    // model can produce a unified summary covering the full conversation, not just
    // the messages since the last watermark.
    const summaryHistory: MessageRecord[] = []
    if (input.thread.rollingSummary) {
      summaryHistory.push({
        id: '__prior-summary__',
        threadId: input.thread.id,
        role: 'assistant',
        content: input.thread.rollingSummary,
        visibleReply: input.thread.rollingSummary,
        status: 'completed',
        createdAt: effectiveMessages[0]?.createdAt ?? new Date().toISOString()
      })
    }

    let buffer = ''
    for await (const delta of runtime.streamReply({
      messages: buildRollingSummaryMessages({
        history: [...summaryHistory, ...effectiveMessages],
        userDocumentContent: userDocument?.content
      }),
      settings,
      signal: new AbortController().signal
    })) {
      if (delta) {
        buffer += delta
      }
    }

    const rollingSummary = buffer.trim()
    const watermarkMessageId = input.thread.headMessageId

    const updatedThread: ThreadRecord = {
      ...input.thread,
      rollingSummary,
      summaryWatermarkMessageId: watermarkMessageId,
      updatedAt: this.deps.timestamp()
    }

    this.deps.storage.updateThread(updatedThread)
    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    return { thread: updatedThread }
  }

  cancelRun(input: { runId: string }): void {
    this.activeRuns.get(input.runId)?.abortController.abort()
  }

  private startFreshRun(input: {
    content: string
    enabledTools: ToolCallName[]
    enabledSkillNames?: string[]
    channelHint?: string
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    thread: ThreadRecord
  }): ChatAccepted {
    const timestamp = this.deps.timestamp()
    const messageSummary = summarizeMessageInput({
      content: input.content,
      images: input.images
    })
    const fallbackTitle =
      input.thread.title === DEFAULT_THREAD_TITLE
        ? deriveThreadTitleFallback({
            content: input.content,
            ...(input.images ? { images: input.images } : {})
          }) || DEFAULT_THREAD_TITLE
        : null
    const userMessage = this.createUserMessage({
      id: input.messageId,
      content: input.content,
      images: input.images,
      attachments: input.attachments,
      parentMessageId: input.thread.headMessageId,
      threadId: input.thread.id,
      timestamp
    })
    const updatedThread: ThreadRecord = {
      ...input.thread,
      headMessageId: userMessage.id,
      ...(messageSummary ? { preview: messageSummary.slice(0, 240) } : {}),
      title: fallbackTitle ?? input.thread.title,
      updatedAt: timestamp
    }
    const accepted: ChatAccepted = {
      kind: 'run-started',
      runId: this.deps.createId(),
      thread: updatedThread,
      userMessage
    }

    this.deps.storage.startRun({
      runId: accepted.runId,
      requestMessageId: userMessage.id,
      thread: input.thread,
      updatedThread,
      userMessage,
      createdAt: timestamp
    })

    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: accepted.thread.id,
      thread: accepted.thread
    })
    this.deps.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: accepted.thread.id,
      runId: accepted.runId,
      requestMessageId: userMessage.id
    })

    if (fallbackTitle && fallbackTitle !== DEFAULT_THREAD_TITLE && input.content) {
      this.scheduleThreadTitleGeneration({
        fallbackTitle,
        query: input.content,
        runId: accepted.runId,
        threadId: accepted.thread.id
      })
    }

    this.startActiveRun({
      enabledTools: input.enabledTools,
      enabledSkillNames: input.enabledSkillNames,
      channelHint: input.channelHint,
      runId: accepted.runId,
      thread: accepted.thread,
      requestMessageId: userMessage.id,
      updateHeadOnComplete: true
    })

    return accepted
  }

  private sendActiveRunSteer(input: {
    activeRunId: string
    content: string
    enabledSkillNames?: string[]
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    thread: ThreadRecord
  }): ChatAccepted {
    const activeRun = this.activeRuns.get(input.activeRunId)
    if (!activeRun) {
      throw new Error('This thread no longer has an active run.')
    }

    if (activeRun.executionPhase === 'tool-running') {
      activeRun.enabledSkillNames = input.enabledSkillNames
        ? [...input.enabledSkillNames]
        : undefined
      activeRun.pendingSteerInput = {
        content: input.content,
        images: input.images,
        attachments: input.attachments,
        messageId: input.messageId,
        timestamp: this.deps.timestamp()
      }

      return {
        kind: 'active-run-steer-pending',
        runId: input.activeRunId,
        thread: input.thread
      }
    }

    activeRun.enabledSkillNames = input.enabledSkillNames ? [...input.enabledSkillNames] : undefined
    const { updatedThread, userMessage } = this.persistSteerMessage({
      content: input.content,
      images: input.images,
      attachments: input.attachments,
      messageId: input.messageId,
      runState: activeRun,
      thread: input.thread,
      timestamp: this.deps.timestamp()
    })

    activeRun.pendingSteerMessageId = userMessage.id
    activeRun.abortController.abort(toRestartRunReason(userMessage.id))

    return {
      kind: 'active-run-steer',
      runId: input.activeRunId,
      thread: updatedThread,
      userMessage
    }
  }

  private queueFollowUp(input: {
    content: string
    enabledTools: ToolCallName[]
    enabledSkillNames?: string[]
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    thread: ThreadRecord
  }): ChatAccepted {
    const activeRunId = this.activeRunByThread.get(input.thread.id)
    const activeRun = activeRunId ? this.activeRuns.get(activeRunId) : null
    if (!activeRunId || !activeRun) {
      return this.startFreshRun(input)
    }

    const timestamp = this.deps.timestamp()
    const previousQueuedMessageId = input.thread.queuedFollowUpMessageId
    const userMessage = this.createUserMessage({
      id: input.messageId,
      content: input.content,
      images: input.images,
      attachments: input.attachments,
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
    if (input.enabledSkillNames !== undefined) {
      updatedThread.queuedFollowUpEnabledSkillNames = [...input.enabledSkillNames]
    } else {
      delete updatedThread.queuedFollowUpEnabledSkillNames
    }

    this.deps.storage.saveThreadMessage({
      thread: input.thread,
      updatedThread,
      message: userMessage,
      ...(previousQueuedMessageId ? { replacedMessageId: previousQueuedMessageId } : {})
    })
    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    return {
      kind: 'active-run-follow-up',
      runId: activeRunId,
      thread: updatedThread,
      userMessage,
      ...(previousQueuedMessageId ? { replacedMessageId: previousQueuedMessageId } : {})
    }
  }

  private createUserMessage(input: {
    id: string
    content: string
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    parentMessageId?: string
    threadId: string
    timestamp: string
  }): MessageRecord {
    return {
      id: input.id,
      threadId: input.threadId,
      ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
      role: 'user',
      content: input.content,
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
      status: 'completed',
      createdAt: input.timestamp
    }
  }

  private persistSteerMessage(input: {
    content: string
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    runState: RunState
    thread: ThreadRecord
    timestamp: string
  }): { updatedThread: ThreadRecord; userMessage: MessageRecord } {
    const userMessage = this.createUserMessage({
      id: input.messageId,
      content: input.content,
      images: input.images,
      attachments: input.attachments,
      parentMessageId: input.runState.pendingSteerMessageId ?? input.runState.requestMessageId,
      threadId: input.thread.id,
      timestamp: input.timestamp
    })
    const updatedThread: ThreadRecord = {
      ...input.thread,
      headMessageId: userMessage.id,
      updatedAt: input.timestamp
    }

    this.deps.storage.saveThreadMessage({
      thread: input.thread,
      updatedThread,
      message: userMessage
    })
    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    return {
      updatedThread,
      userMessage
    }
  }

  private startActiveRun(input: {
    enabledTools: ToolCallName[]
    enabledSkillNames?: string[]
    channelHint?: string
    runId: string
    thread: ThreadRecord
    requestMessageId: string
    updateHeadOnComplete: boolean
  }): void {
    this.activeRuns.set(input.runId, {
      threadId: input.thread.id,
      requestMessageId: input.requestMessageId,
      ...(input.enabledSkillNames ? { enabledSkillNames: [...input.enabledSkillNames] } : {}),
      ...(input.channelHint ? { channelHint: input.channelHint } : {}),
      abortController: new AbortController(),
      executionPhase: 'generating',
      updateHeadOnComplete: input.updateHeadOnComplete
    })
    this.activeRunByThread.set(input.thread.id, input.runId)

    const runTask = this.runLoop({
      enabledTools: input.enabledTools,
      enabledSkillNames: input.enabledSkillNames,
      channelHint: input.channelHint,
      runId: input.runId,
      thread: input.thread,
      requestMessageId: input.requestMessageId,
      updateHeadOnComplete: input.updateHeadOnComplete
    })
    this.activeRunTasks.set(input.runId, runTask)
    void runTask
  }

  private startAssistantOnlyRun(input: {
    runId: string
    thread: ThreadRecord
    sourceMessages: MessageRecord[]
  }): void {
    this.activeRuns.set(input.runId, {
      threadId: input.thread.id,
      abortController: new AbortController(),
      executionPhase: 'generating',
      updateHeadOnComplete: true
    })
    this.activeRunByThread.set(input.thread.id, input.runId)

    const runTask = this.streamCompactThreadHandoff(input)
    this.activeRunTasks.set(input.runId, runTask)
    void runTask
  }

  private async runLoop(input: {
    enabledTools: ToolCallName[]
    enabledSkillNames?: string[]
    channelHint?: string
    runId: string
    thread: ThreadRecord
    requestMessageId: string
    updateHeadOnComplete: boolean
  }): Promise<void> {
    let currentThread = input.thread
    let currentRequestMessageId = input.requestMessageId
    let previousEnabledTools = this.lastRunEnabledTools
    let result: ExecuteRunResult = { kind: 'cancelled' }

    try {
      while (true) {
        const activeRun = this.activeRuns.get(input.runId)
        if (!activeRun) {
          return
        }

        const abortController = new AbortController()
        activeRun.abortController = abortController
        activeRun.requestMessageId = currentRequestMessageId

        result = await executeServerRun(
          {
            storage: this.deps.storage,
            createId: this.deps.createId,
            timestamp: this.deps.timestamp,
            emit: this.deps.emit,
            createModelRuntime: this.deps.createModelRuntime,
            ensureThreadWorkspace: this.deps.ensureThreadWorkspace,
            buildMemoryLayerEntries: async (context) => {
              if (context.thread.privacyMode) {
                return { entries: [], recallDecision: undefined }
              }
              const branchHistory = collectMessagePath(
                this.deps.loadThreadMessages(context.thread.id),
                context.requestMessageId
              )
              const result = await this.deps.memoryService.recallForContext({
                history: branchHistory,
                now: context.thread.updatedAt,
                signal: context.signal,
                thread: context.thread,
                userQuery: context.userQuery
              })
              const persistedThread = this.deps.requireThread(context.thread.id)
              this.deps.storage.updateThread({
                ...persistedThread,
                memoryRecall: result.thread.memoryRecall
              })
              return {
                entries: result.entries,
                recallDecision: result.decision
              }
            },
            fetchImpl: this.deps.fetchImpl,
            loadBrowserSnapshot: this.deps.loadBrowserSnapshot,
            memoryService: this.deps.memoryService,
            searchService: this.deps.searchService,
            webSearchService: this.deps.webSearchService,
            readSoulDocument: this.deps.readSoulDocument,
            readUserDocument: this.deps.readUserDocument,
            readThread: this.deps.requireThread,
            readConfig: this.deps.readConfig,
            readSettings: () =>
              toEffectiveProviderSettings(
                this.deps.readConfig(),
                this.deps.requireThread(currentThread.id).modelOverride
              ),
            loadThreadMessages: this.deps.loadThreadMessages,
            loadThreadToolCalls: this.deps.loadThreadToolCalls,
            listSkills: this.deps.listSkills,
            onEnabledToolsUsed: (enabledTools) => {
              this.lastRunEnabledTools = [...enabledTools]
            },
            onExecutionPhaseChange: (phase) => {
              const currentRun = this.activeRuns.get(input.runId)
              if (!currentRun) {
                return
              }

              currentRun.executionPhase = phase
            },
            onSafeToSteerAfterTool: () => {
              const currentRun = this.activeRuns.get(input.runId)
              if (!currentRun?.pendingSteerInput) {
                return
              }

              const currentThread = this.deps.requireThread(input.thread.id)
              const { userMessage } = this.persistSteerMessage({
                content: currentRun.pendingSteerInput.content,
                images: currentRun.pendingSteerInput.images,
                attachments: currentRun.pendingSteerInput.attachments,
                messageId: currentRun.pendingSteerInput.messageId,
                runState: currentRun,
                thread: currentThread,
                timestamp: currentRun.pendingSteerInput.timestamp
              })

              // Push the full thread state so the frontend receives the new steer user
              // message in its messages array. thread.updated alone does not carry message
              // data, which would leave the steer message missing from the client tree and
              // break group / tool-call visibility until the next bootstrap.
              this.emitThreadStateReplaced(input.thread.id)

              currentRun.pendingSteerInput = undefined
              currentRun.pendingSteerMessageId = userMessage.id
              currentRun.abortController.abort(toRestartRunReason(userMessage.id))
            },
            onSubagentProgress: (chunk: string) => {
              this.deps.emit<SubagentProgressEvent>({
                type: 'subagent.progress',
                threadId: input.thread.id,
                runId: input.runId,
                chunk
              })
            },
            onTerminalState: () => {
              this.activeRuns.delete(input.runId)
              this.activeRunByThread.delete(input.thread.id)
              this.activeRunTasks.delete(input.runId)
            }
          },
          {
            abortController,
            enabledTools: input.enabledTools,
            enabledSkillNames: activeRun.enabledSkillNames ?? input.enabledSkillNames,
            channelHint: activeRun.channelHint ?? input.channelHint,
            previousEnabledTools,
            requestMessageId: currentRequestMessageId,
            runId: input.runId,
            thread: currentThread,
            updateHeadOnComplete: input.updateHeadOnComplete
          }
        )

        previousEnabledTools = input.enabledTools

        if (result.kind === 'completed') {
          const threadMessages = this.deps.loadThreadMessages(currentThread.id)
          const assistantMessage = threadMessages
            .filter(
              (message) =>
                message.role === 'assistant' && message.parentMessageId === currentRequestMessageId
            )
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
            .at(-1)
          const userMessage = threadMessages.find(
            (message) => message.id === currentRequestMessageId && message.role === 'user'
          )

          if (assistantMessage && userMessage) {
            this.schedulePostRunMemoryDistillation({
              assistantResponse: assistantMessage.content,
              thread: currentThread,
              userQuery: userMessage.content
            })
          }
        }

        if (result.kind !== 'restarted') {
          break
        }

        const nextRequestMessageId = activeRun.pendingSteerMessageId ?? result.nextRequestMessageId

        activeRun.pendingSteerMessageId = undefined
        activeRun.pendingSteerInput = undefined
        activeRun.executionPhase = 'generating'
        activeRun.requestMessageId = nextRequestMessageId
        currentRequestMessageId = nextRequestMessageId
        currentThread = this.deps.requireThread(input.thread.id)
        this.emitThreadStateReplaced(currentThread.id)
      }
    } finally {
      this.activeRuns.delete(input.runId)
      this.activeRunByThread.delete(input.thread.id)
      this.activeRunTasks.delete(input.runId)

      if (!this.isClosing && result.kind !== 'restarted') {
        this.startQueuedFollowUpIfPresent(input.thread.id)
      }
    }
  }

  private async streamCompactThreadHandoff(input: {
    runId: string
    thread: ThreadRecord
    sourceMessages: MessageRecord[]
  }): Promise<void> {
    const settings = this.deps.readSettings()
    const runtime = this.deps.createModelRuntime()
    const messageId = this.deps.createId()
    let buffer = ''

    this.deps.emit<MessageStartedEvent>({
      type: 'message.started',
      threadId: input.thread.id,
      runId: input.runId,
      messageId
    })

    try {
      const userDocument = this.deps.readUserDocument ? await this.deps.readUserDocument() : null
      const activeRun = this.activeRuns.get(input.runId)
      if (!activeRun) {
        return
      }

      for await (const delta of runtime.streamReply({
        messages: buildCompactThreadHandoffMessages({
          history: input.sourceMessages,
          userDocumentContent: userDocument?.content
        }),
        settings,
        signal: activeRun.abortController.signal
      })) {
        if (!delta) {
          continue
        }

        buffer += delta
        this.deps.emit<MessageDeltaEvent>({
          type: 'message.delta',
          threadId: input.thread.id,
          runId: input.runId,
          messageId,
          delta
        })
      }

      const timestamp = this.deps.timestamp()
      const assistantMessage: MessageRecord = {
        id: messageId,
        threadId: input.thread.id,
        role: 'assistant',
        content: buffer,
        status: 'completed',
        createdAt: timestamp,
        modelId: settings.model,
        providerName: settings.providerName
      }
      const currentThread = this.deps.requireThread(input.thread.id)
      const firstMeaningfulMessage =
        currentThread.title === DEFAULT_THREAD_TITLE
          ? input.sourceMessages.find(
              (m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim()
            )
          : undefined
      const handoffFallbackTitle = firstMeaningfulMessage
        ? deriveThreadTitleFallback({
            content: firstMeaningfulMessage.content,
            ...('images' in firstMeaningfulMessage && firstMeaningfulMessage.images
              ? { images: firstMeaningfulMessage.images }
              : {})
          })
        : null
      const updatedThread: ThreadRecord = {
        ...currentThread,
        headMessageId: assistantMessage.id,
        preview: assistantMessage.content.slice(0, 240),
        ...(handoffFallbackTitle ? { title: handoffFallbackTitle } : {}),
        updatedAt: timestamp
      }

      this.deps.storage.completeRun({
        runId: input.runId,
        updatedThread,
        assistantMessage
      })
      this.activeRuns.delete(input.runId)
      this.activeRunByThread.delete(input.thread.id)
      this.activeRunTasks.delete(input.runId)

      this.deps.emit<MessageCompletedEvent>({
        type: 'message.completed',
        threadId: input.thread.id,
        runId: input.runId,
        message: assistantMessage
      })
      this.deps.emit<ThreadUpdatedEvent>({
        type: 'thread.updated',
        threadId: input.thread.id,
        thread: updatedThread
      })
      this.deps.emit<RunCompletedEvent>({
        type: 'run.completed',
        threadId: input.thread.id,
        runId: input.runId
      })

      if (handoffFallbackTitle && firstMeaningfulMessage?.content) {
        this.scheduleThreadTitleGeneration({
          fallbackTitle: handoffFallbackTitle,
          query: firstMeaningfulMessage.content,
          runId: input.runId,
          threadId: input.thread.id
        })
      }
    } catch (error) {
      const timestamp = this.deps.timestamp()
      const message = error instanceof Error ? error.message : String(error)

      if (isAbortError(error)) {
        this.deps.storage.cancelRun({
          runId: input.runId,
          completedAt: timestamp
        })
      } else {
        this.deps.storage.failRun({
          runId: input.runId,
          completedAt: timestamp,
          error: message
        })
      }
      this.activeRuns.delete(input.runId)
      this.activeRunByThread.delete(input.thread.id)
      this.activeRunTasks.delete(input.runId)

      if (isAbortError(error)) {
        this.deps.emit<RunCancelledEvent>({
          type: 'run.cancelled',
          threadId: input.thread.id,
          runId: input.runId
        })
      } else {
        this.deps.emit<RunFailedEvent>({
          type: 'run.failed',
          threadId: input.thread.id,
          runId: input.runId,
          error: message
        })
      }
    }
  }

  private schedulePostRunMemoryDistillation(input: {
    assistantResponse: string
    thread: ThreadRecord
    userQuery: string
  }): void {
    if (!this.deps.memoryService.isConfigured()) {
      return
    }

    if (input.thread.privacyMode) {
      return
    }

    // Skip memory distillation for external channel threads — conversations are
    // short and ephemeral; distilling them pollutes the owner's memory store.
    if (input.thread.source && input.thread.source !== 'local') {
      return
    }

    const abortController = new AbortController()
    this.backgroundMemoryTaskControllers.add(abortController)

    const task: Promise<void> | undefined = (async (): Promise<void> => {
      try {
        await this.deps.memoryService.distillCompletedRun({
          assistantResponse: input.assistantResponse,
          signal: abortController.signal,
          thread: input.thread,
          userQuery: input.userQuery
        })
      } catch {
        // Memory distillation must not affect the completed run path.
      } finally {
        this.backgroundMemoryTaskControllers.delete(abortController)
        if (task) {
          this.backgroundMemoryTasks.delete(task)
        }
      }
    })()

    this.backgroundMemoryTasks.add(task)
    void task
  }

  private scheduleThreadTitleGeneration(input: {
    fallbackTitle: string
    query: string
    runId: string
    threadId: string
  }): void {
    this.logThreadTitleDebug({
      phase: 'queued',
      runId: input.runId,
      threadId: input.threadId,
      message: 'Queued parallel title generation from the initial user message.'
    })

    const abortController = new AbortController()
    this.backgroundTitleTaskControllers.add(abortController)
    const task: Promise<void> | undefined = (async (): Promise<void> => {
      try {
        await this.refineThreadTitle({
          fallbackTitle: input.fallbackTitle,
          query: input.query,
          runId: input.runId,
          signal: abortController.signal,
          threadId: input.threadId
        })
      } catch {
        // Auxiliary title refinement must never break the primary thread flow.
      } finally {
        this.backgroundTitleTaskControllers.delete(abortController)
        if (task) {
          this.backgroundTitleTasks.delete(task)
        }
      }
    })()

    this.backgroundTitleTasks.add(task)
    void task
  }

  private async refineThreadTitle(input: {
    fallbackTitle: string
    query: string
    runId: string
    signal: AbortSignal
    threadId: string
  }): Promise<void> {
    const thread = this.deps.requireThread(input.threadId)
    if (thread.source && thread.source !== 'local') {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title generation for channel thread.',
        detail: `source=${thread.source}`
      })
      return
    }
    if (thread.title !== input.fallbackTitle) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title generation because the thread title already changed.',
        detail: 'title-mismatch-before-start'
      })
      return
    }

    if (!input.query.trim()) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title generation because the initial user query was empty.',
        detail: 'empty-query'
      })
      return
    }

    this.logThreadTitleDebug({
      phase: 'started',
      runId: input.runId,
      threadId: input.threadId,
      message: 'Started title generation in parallel with the main run.'
    })

    const result = await this.deps.auxiliaryGeneration.generateText({
      messages: buildThreadTitleGenerationMessages(input.query),
      signal: input.signal
    })

    if (result.status === 'unavailable') {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title generation because the tool model was unavailable.',
        detail: result.reason
      })
      return
    }

    if (result.status === 'failed') {
      this.logThreadTitleDebug({
        phase: 'failed',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Title generation failed.',
        detail: result.error
      })
      return
    }

    this.logThreadTitleDebug({
      phase: 'raw-output',
      runId: input.runId,
      threadId: input.threadId,
      message: 'Received raw title-model output.',
      detail: formatThreadTitleDebugValue(result.text)
    })

    const { icon, title } = parseGeneratedTitleAndIcon(result.text)
    this.logThreadTitleDebug({
      phase: 'sanitized-output',
      runId: input.runId,
      threadId: input.threadId,
      message: 'Computed sanitized title candidate.',
      detail: formatThreadTitleDebugValue(title ? `${icon ?? ''} ${title}`.trim() : '')
    })

    if (!title) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title update because the generated title was empty after sanitization.',
        detail: 'empty-generated-title'
      })
      return
    }

    if (title === input.fallbackTitle) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title update because the generated title matched the fallback title.',
        detail: 'same-as-fallback'
      })
      return
    }

    const latestThread = this.deps.requireThread(input.threadId)
    if (latestThread.title !== input.fallbackTitle) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message:
          'Skipped title update because the thread title changed while generation was running.',
        detail: 'title-mismatch-after-generation'
      })
      return
    }

    const updatedThread: ThreadRecord = {
      ...latestThread,
      ...(icon !== null ? { icon } : {}),
      title,
      updatedAt: this.deps.timestamp()
    }

    this.deps.storage.updateThread(updatedThread)
    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })
    this.logThreadTitleDebug({
      phase: 'succeeded',
      runId: input.runId,
      threadId: input.threadId,
      message: 'Updated the thread title and icon from the tool-model result.',
      detail: icon ? `${icon} ${title}` : title
    })
  }

  private logThreadTitleDebug(input: {
    phase:
      | 'queued'
      | 'started'
      | 'raw-output'
      | 'sanitized-output'
      | 'succeeded'
      | 'skipped'
      | 'failed'
    runId: string
    threadId: string
    message: string
    detail?: string
  }): void {
    console.debug(
      '[yachiyo][thread-title]',
      `phase=${input.phase}`,
      `threadId=${input.threadId}`,
      `runId=${input.runId}`,
      input.message,
      ...(input.detail ? [`detail=${input.detail}`] : [])
    )
  }

  private startQueuedFollowUpIfPresent(threadId: string): void {
    const prepared = this.prepareQueuedFollowUpStart(threadId)
    if (!prepared) {
      return
    }

    this.activatePreparedQueuedFollowUp(prepared, {
      emitThreadStateReplaced: true
    })
  }

  private prepareQueuedFollowUpStart(threadId: string): PreparedQueuedFollowUpStart | null {
    if (this.activeRunByThread.has(threadId)) {
      return null
    }

    const thread = this.deps.requireThread(threadId)
    const queuedMessageId = thread.queuedFollowUpMessageId
    if (!queuedMessageId) {
      if (thread.queuedFollowUpEnabledTools || thread.queuedFollowUpEnabledSkillNames) {
        const clearedThread: ThreadRecord = {
          ...thread,
          updatedAt: this.deps.timestamp()
        }
        delete clearedThread.queuedFollowUpEnabledTools
        delete clearedThread.queuedFollowUpEnabledSkillNames
        this.deps.storage.updateThread(clearedThread)
      }
      return null
    }

    const queuedMessage = this.deps
      .loadThreadMessages(threadId)
      .find((message) => message.id === queuedMessageId && message.role === 'user')
    if (!queuedMessage) {
      const clearedThread: ThreadRecord = {
        ...thread,
        updatedAt: this.deps.timestamp()
      }
      delete clearedThread.queuedFollowUpEnabledTools
      delete clearedThread.queuedFollowUpEnabledSkillNames
      delete clearedThread.queuedFollowUpMessageId

      this.deps.storage.updateThread(clearedThread)
      return null
    }

    const reparentedQueuedMessage = withParentMessageId(queuedMessage, thread.headMessageId)
    if (reparentedQueuedMessage.parentMessageId !== queuedMessage.parentMessageId) {
      this.deps.storage.updateMessage(reparentedQueuedMessage)
    }

    const timestamp = this.deps.timestamp()
    const messageSummary = summarizeMessageInput(reparentedQueuedMessage)
    const updatedThread: ThreadRecord = {
      ...thread,
      headMessageId: queuedMessage.id,
      ...(messageSummary ? { preview: messageSummary.slice(0, 240) } : {}),
      updatedAt: timestamp
    }
    delete updatedThread.queuedFollowUpEnabledTools
    delete updatedThread.queuedFollowUpEnabledSkillNames
    delete updatedThread.queuedFollowUpMessageId

    this.deps.storage.updateThread(updatedThread)

    const enabledTools = thread.queuedFollowUpEnabledTools
      ? [...thread.queuedFollowUpEnabledTools]
      : resolveEnabledTools(undefined, this.deps.readConfig().enabledTools)
    const enabledSkillNames =
      thread.queuedFollowUpEnabledSkillNames === undefined
        ? undefined
        : normalizeSkillNames(thread.queuedFollowUpEnabledSkillNames)
    const runId = this.deps.createId()

    return {
      createdAt: timestamp,
      enabledTools,
      enabledSkillNames,
      requestMessageId: queuedMessage.id,
      runId,
      thread: updatedThread
    }
  }

  private activatePreparedQueuedFollowUp(
    prepared: PreparedQueuedFollowUpStart,
    options: { emitThreadStateReplaced?: boolean } = {}
  ): void {
    if (this.isClosing || this.activeRunByThread.has(prepared.thread.id)) {
      return
    }

    const currentThread = this.deps.requireThread(prepared.thread.id)
    this.deps.storage.startRun({
      runId: prepared.runId,
      requestMessageId: prepared.requestMessageId,
      thread: currentThread,
      updatedThread: prepared.thread,
      createdAt: prepared.createdAt
    })

    if (options.emitThreadStateReplaced) {
      this.emitThreadStateReplaced(prepared.thread.id)
    }

    this.deps.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: prepared.thread.id,
      runId: prepared.runId,
      requestMessageId: prepared.requestMessageId
    })

    this.startActiveRun({
      enabledTools: prepared.enabledTools,
      enabledSkillNames: prepared.enabledSkillNames,
      runId: prepared.runId,
      thread: prepared.thread,
      requestMessageId: prepared.requestMessageId,
      updateHeadOnComplete: true
    })
  }

  private emitThreadStateReplaced(threadId: string): void {
    const thread = this.deps.requireThread(threadId)
    const messages = this.deps.loadThreadMessages(threadId)
    const toolCalls = this.deps.loadThreadToolCalls(threadId)

    this.deps.emit<ThreadStateReplacedEvent>({
      type: 'thread.state.replaced',
      threadId,
      thread,
      messages,
      toolCalls
    })
  }
}

function formatThreadTitleDebugValue(value: string): string {
  const serialized = JSON.stringify(value)
  return serialized.length <= 240 ? serialized : `${serialized.slice(0, 237)}...`
}
