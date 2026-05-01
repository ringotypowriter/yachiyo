import { resolve } from 'node:path'
import type { ToolSet } from 'ai'

import type {
  BackgroundTaskCompletedEvent,
  BackgroundTaskLogAppendEvent,
  BackgroundTaskSnapshot,
  BackgroundTaskStartedEvent,
  ChatAccepted,
  CompactThreadAccepted,
  HarnessFinishedEvent,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageReasoningDeltaEvent,
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
  RunUsageUpdatedEvent,
  SendChatInput,
  SendChatMode,
  SkillCatalogEntry,
  SettingsConfig,
  SubagentProgressEvent,
  ThreadRecord,
  ThreadStateReplacedEvent,
  ThreadUpdatedEvent,
  ToolCallUpdatedEvent,
  ToolCallRecord,
  ToolCallName
} from '../../../../shared/yachiyo/protocol.ts'
import { saveFileAttachmentsToWorkspace, saveImageFilesToWorkspace } from './attachmentDomain.ts'
import {
  hasMessagePayload,
  normalizeMessageImages,
  summarizeMessageInput
} from '../../../../shared/yachiyo/messageContent.ts'
import { getThreadCapabilities, normalizeSkillNames } from '../../../../shared/yachiyo/protocol.ts'
import type { AuxiliaryGenerationService } from '../../runtime/auxiliaryGeneration.ts'
import type { MemoryService } from '../../services/memory/memoryService.ts'
import {
  createMemoryDistillationScheduler,
  type MemoryDistillationScheduler
} from '../../services/memory/memoryDistillationScheduler.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import type { WebSearchService } from '../../services/webSearch/webSearchService.ts'
import type { BrowserWebPageSnapshotLoader } from '../../services/webRead/browserWebPageSnapshot.ts'
import type { JotdownStore } from '../../services/jotdownStore.ts'
import type { ModelRuntime } from '../../runtime/types.ts'
import type { RunRecoveryCheckpoint, YachiyoStorage } from '../../storage/storage.ts'
import {
  collectMessagePath,
  wouldCreateParentCycle
} from '../../../../shared/yachiyo/threadTree.ts'
import { BackgroundBashManager, type BackgroundBashTaskResult } from './backgroundBashManager.ts'
import { assertSupportedImages, resolveEnabledTools } from './configDomain.ts'
import { toEffectiveProviderSettings } from '../../settings/settingsStore.ts'
import { isModelImageCapable } from '../../../../shared/yachiyo/providerConfig.ts'
import type { ModelUsage } from '../../runtime/types.ts'
import {
  executeServerRun,
  prepareServerRunContext,
  type ExecuteRunInput,
  type ExecuteRunResult
} from './runExecution.ts'
import { createAgentToolSet, ReadRecordCache } from '../../tools/agentTools.ts'
import { SnapshotTracker } from '../../services/fileSnapshot/snapshotTracker.ts'
import { runAcpChatThread } from '../../runtime/acp/acpChatRuntime.ts'
import {
  buildThreadTitleGenerationMessages,
  buildTitleQuery,
  deriveThreadTitleFallback,
  THREAD_TITLE_MAX_TOKEN,
  parseGeneratedTitleAndIcon
} from './threadTitle.ts'
import { resolveRetryRequest } from './threadDomain.ts'
import { buildThreadHandoffPrompt } from '../../runtime/threadHandoff.ts'
import type { SoulDocument } from '../../runtime/soul.ts'
import type { UserDocument } from '../../runtime/user.ts'
import { resolveYachiyoUserPath } from '../../config/paths.ts'
import { sleep } from '../../channels/connectionRetry.ts'
import {
  DEFAULT_HARNESS_NAME,
  DEFAULT_THREAD_TITLE,
  INTERRUPTED_RUN_ERROR,
  SHUTDOWN_RUN_ERROR,
  isAbortError,
  createDeltaBatcher,
  type CreateId,
  type EmitServerEvent,
  type Timestamp
} from './shared.ts'

interface RunState {
  threadId: string
  requestMessageId?: string
  enabledSkillNames?: string[]
  channelHint?: string
  recoveryCheckpoint?: RunRecoveryCheckpoint
  recoveringHarnessId?: string
  abortController: AbortController
  pendingSteerMessageId?: string
  pendingSteerInput?: {
    content: string
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    timestamp: string
    hidden?: boolean
    previousEnabledSkillNames?: string[]
  }
  executionPhase: 'generating' | 'tool-running' | 'waiting-for-user'
  updateHeadOnComplete: boolean
  /** Resolves a pending askUser tool call with the user's answer. Set by execution. */
  answerToolQuestion?: (toolCallId: string, answer: string) => void
  /** When true, this run is an ephemeral recap — no messages persisted, result returned via recapResolve. */
  recap?: boolean
  recapResolve?: (text: string | null) => void
  recapUserMessage?: MessageRecord
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
  runInactivityTimeoutMs: number
  auxiliaryGeneration: AuxiliaryGenerationService
  createModelRuntime: () => ModelRuntime
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  fetchImpl?: typeof globalThis.fetch
  webExternalFetchImpl?: typeof globalThis.fetch
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
  jotdownStore?: JotdownStore
  imageToTextService?: import('../../services/imageToText/imageToTextService.ts').ImageToTextService
}

interface DebouncedSendChatEntry {
  expiresAt: number
  promise: Promise<ChatAccepted>
  stateSignature?: string
}

const SEND_CHAT_DEBOUNCE_WINDOW_MS = 1_500

type EphemeralStorage = YachiyoStorage & { lastAssistantContent: string | null }

function createEphemeralStorageProxy(real: YachiyoStorage): EphemeralStorage {
  const state = { lastAssistantContent: null as string | null }
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'lastAssistantContent') return state.lastAssistantContent
      if (
        prop === 'startRun' ||
        prop === 'cancelRun' ||
        prop === 'failRun' ||
        prop === 'saveThreadMessage' ||
        prop === 'updateThread' ||
        prop === 'updateMessage' ||
        prop === 'persistResponseMessagesRepairInBackground' ||
        prop === 'createToolCall' ||
        prop === 'updateToolCall' ||
        prop === 'upsertRunRecoveryCheckpoint' ||
        prop === 'deleteRunRecoveryCheckpoint' ||
        prop === 'updateRunSnapshot'
      ) {
        return () => {}
      }
      if (prop === 'flushBackgroundTasks') {
        return async () => {}
      }
      if (prop === 'completeRun') {
        return (input: { assistantMessage?: MessageRecord }) => {
          state.lastAssistantContent = input.assistantMessage?.content ?? null
        }
      }
      return Reflect.get(target, prop, receiver)
    }
  }) as EphemeralStorage
}

function withParentMessageId(message: MessageRecord, parentMessageId?: string): MessageRecord {
  const rest = { ...message }
  delete rest.parentMessageId

  return {
    ...rest,
    ...(parentMessageId ? { parentMessageId } : {})
  }
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

function disableHandoffToolExecution(tools: ToolSet | undefined): ToolSet | undefined {
  if (!tools) {
    return undefined
  }

  const disabledTools: ToolSet = {}
  for (const [name, tool] of Object.entries(tools)) {
    disabledTools[name] = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
      execute: async () => {
        throw new Error('Tool execution is disabled during handoff creation.')
      }
    })
  }

  return disabledTools
}

function findLatestUserTurnContext(messages: MessageRecord[]): MessageRecord['turnContext'] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user' && message.turnContext) {
      return message.turnContext
    }
  }
  return undefined
}

type UsageFields = Pick<
  ModelUsage,
  | 'promptTokens'
  | 'completionTokens'
  | 'totalPromptTokens'
  | 'totalCompletionTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
>

/** Extract the six token-count fields for passing to cancelRun/failRun. */
function usageFieldsFrom(usage: UsageFields | undefined): Partial<UsageFields> {
  if (!usage) return {}
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalPromptTokens: usage.totalPromptTokens,
    totalCompletionTokens: usage.totalCompletionTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens
  }
}

/** Merge accumulated prior-leg totals with the current leg's ModelUsage for terminal persistence. */
function mergeUsageForTerminal(
  prior: UsageFields | undefined,
  current: ModelUsage | undefined
): UsageFields | undefined {
  if (!prior && !current) return undefined
  if (!prior) return current
  if (!current) return prior
  return {
    promptTokens: current.promptTokens,
    completionTokens: (prior.completionTokens ?? 0) + current.completionTokens,
    totalPromptTokens: (prior.totalPromptTokens ?? 0) + current.totalPromptTokens,
    totalCompletionTokens: (prior.totalCompletionTokens ?? 0) + current.totalCompletionTokens,
    cacheReadTokens: (prior.cacheReadTokens ?? 0) + (current.cacheReadTokens ?? 0),
    cacheWriteTokens: (prior.cacheWriteTokens ?? 0) + (current.cacheWriteTokens ?? 0)
  }
}

export class YachiyoServerRunDomain {
  private readonly deps: RunDomainDeps
  private readonly activeRuns = new Map<string, RunState>()
  private readonly activeRunByThread = new Map<string, string>()
  private readonly activeRunTasks = new Map<string, Promise<void>>()
  private readonly backgroundTitleTasks = new Set<Promise<void>>()
  private readonly backgroundTitleTaskControllers = new Set<AbortController>()
  private readonly debouncedSendChats = new Map<string, DebouncedSendChatEntry>()
  private readonly backgroundBashManager = new BackgroundBashManager()
  /**
   * Per-task snapshot of the launching run's channel/tooling context, captured at
   * `onBackgroundBashStarted`. We use it to call `sendChat` with the same `enabledTools`,
   * `enabledSkillNames`, `channelHint`, and `extraTools` (e.g. an owner-DM `replyTool`)
   * when the background task finishes, so the auto-delivered "background task completed"
   * user message can drive a model run that matches the original transport contract.
   */
  private readonly backgroundTaskRunContext = new Map<
    string,
    {
      enabledTools: ToolCallName[]
      enabledSkillNames?: string[]
      channelHint?: string
      extraTools?: import('ai').ToolSet
    }
  >()
  private readonly memoryScheduler: MemoryDistillationScheduler
  private readonly readRecordCaches = new Map<string, ReadRecordCache>()
  private lastRunEnabledTools: ToolCallName[] | null
  private isClosing = false

  constructor(deps: RunDomainDeps) {
    this.deps = deps
    this.lastRunEnabledTools = null
    this.memoryScheduler = createMemoryDistillationScheduler({
      memoryService: deps.memoryService,
      readConfig: deps.readConfig,
      loadThreadMessages: deps.loadThreadMessages,
      getThread: (threadId) => deps.storage.getThread(threadId),
      getThreadTotalTokens: (threadId) => deps.storage.getThreadTotalTokens(threadId)
    })

    this.backgroundBashManager.setCompletionHandler((result) => {
      this.handleBackgroundBashCompleted(result)
    })
    this.backgroundBashManager.setLogAppendHandler((append) => {
      if (this.isClosing) return
      try {
        this.deps.emit<BackgroundTaskLogAppendEvent>({
          type: 'background-task.log-append',
          threadId: append.threadId,
          taskId: append.taskId,
          lines: append.lines
        })
      } catch (error) {
        console.warn('[yachiyo][background-bash] log-append emit failed', {
          taskId: append.taskId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })
  }

  listBackgroundTasks(threadId?: string): BackgroundTaskSnapshot[] {
    return this.backgroundBashManager.listSnapshots(threadId)
  }

  getBackgroundTaskLogTarget(input: {
    threadId: string
    taskId: string
  }): ReturnType<BackgroundBashManager['getLogTarget']> {
    return this.backgroundBashManager.getLogTarget(input.threadId, input.taskId)
  }

  cancelBackgroundTask(taskId: string): boolean {
    return this.backgroundBashManager.cancelTask(taskId)
  }

  hasActiveThread(threadId: string): boolean {
    return this.hasNonRecapActiveRun(threadId)
  }

  private hasNonRecapActiveRun(threadId: string): boolean {
    const runId = this.activeRunByThread.get(threadId)
    if (!runId) return false
    const run = this.activeRuns.get(runId)
    return run != null && !run.recap
  }

  async close(): Promise<void> {
    this.isClosing = true

    for (const state of this.activeRuns.values()) {
      state.abortController.abort()
    }
    for (const controller of this.backgroundTitleTaskControllers.values()) {
      controller.abort()
    }

    await this.backgroundBashManager.close()

    if (this.activeRunTasks.size > 0) {
      await Promise.allSettled(this.activeRunTasks.values())
    }
    if (this.backgroundTitleTasks.size > 0) {
      await Promise.allSettled(this.backgroundTitleTasks)
    }
    await this.memoryScheduler.close()

    this.recoverInterruptedRuns(SHUTDOWN_RUN_ERROR)
    this.activeRuns.clear()
    this.activeRunByThread.clear()
    this.activeRunTasks.clear()
    this.backgroundTitleTaskControllers.clear()
    this.backgroundTitleTasks.clear()
    this.debouncedSendChats.clear()
    this.backgroundTaskRunContext.clear()
    this.readRecordCaches.clear()
  }

  clearReadRecordCache(threadId: string): void {
    this.readRecordCaches.delete(threadId)
  }

  private bindTerminalToolCallsToAssistant(input: {
    threadId: string
    runId: string
    assistantMessageId: string
  }): void {
    const toolCalls = this.deps
      .loadThreadToolCalls(input.threadId)
      .filter(
        (toolCall) =>
          toolCall.runId === input.runId &&
          toolCall.status !== 'preparing' &&
          toolCall.status !== 'running' &&
          toolCall.assistantMessageId !== input.assistantMessageId
      )

    for (const toolCall of toolCalls) {
      const updatedToolCall: ToolCallRecord = {
        ...toolCall,
        assistantMessageId: input.assistantMessageId
      }
      this.deps.storage.updateToolCall(updatedToolCall)
      this.deps.emit<ToolCallUpdatedEvent>({
        type: 'tool.updated',
        threadId: input.threadId,
        runId: input.runId,
        toolCall: updatedToolCall
      })
    }
  }

  private emitCancelledHarnessFinished(input: {
    threadId: string
    runId: string
    harnessId?: string
  }): void {
    if (!input.harnessId) {
      return
    }

    this.deps.emit<HarnessFinishedEvent>({
      type: 'harness.finished',
      threadId: input.threadId,
      runId: input.runId,
      harnessId: input.harnessId,
      name: DEFAULT_HARNESS_NAME,
      status: 'cancelled'
    })
  }

  recoverInterruptedRuns(error: string = INTERRUPTED_RUN_ERROR): void {
    this.deps.storage.recoverInterruptedRuns({
      error,
      finishedAt: this.deps.timestamp()
    })
    this.recoverOrphanedBackgroundToolCalls()
  }

  private recoverOrphanedBackgroundToolCalls(): void {
    const timestamp = this.deps.timestamp()
    const bootstrap = this.deps.storage.bootstrap()

    // Walk every thread that could possibly own a background bash tool call: active local
    // threads, archived threads, and external/channel threads. The default `bootstrap()`
    // result excludes archived and (in sqlite) channel threads, so a background task
    // launched in an archived conversation or an owner DM would otherwise be stuck in an
    // active-looking state forever after a restart.
    const seen = new Set<string>()
    const allThreads: ThreadRecord[] = []
    const collect = (thread: ThreadRecord): void => {
      if (seen.has(thread.id)) return
      seen.add(thread.id)
      allThreads.push(thread)
    }
    for (const thread of bootstrap.threads) collect(thread)
    for (const thread of bootstrap.archivedThreads) collect(thread)
    for (const thread of this.deps.storage.listExternalThreads()) collect(thread)

    for (const thread of allThreads) {
      const toolCalls = this.deps.loadThreadToolCalls(thread.id)
      for (const tc of toolCalls) {
        if (tc.status === 'background') {
          const updated: ToolCallRecord = {
            ...tc,
            status: 'failed',
            error: 'Background task interrupted by app restart',
            finishedAt: timestamp
          }
          this.deps.storage.updateToolCall(updated)
        }
      }
    }
  }

  private handleBackgroundBashCompleted(result: BackgroundBashTaskResult): void {
    if (this.isClosing) return

    try {
      const timestamp = this.deps.timestamp()

      // 1. Update ToolCallRecord status/exitCode for the renderer. The model-facing
      // `output` blob is left untouched: history must remain truthful that the launch
      // call only ever returned the `{taskId, logPath}` handle.
      const cancelled = result.cancelledByUser === true

      if (result.toolCallId) {
        const toolCalls = this.deps.loadThreadToolCalls(result.threadId)
        const tc = toolCalls.find((t) => t.id === result.toolCallId)
        if (tc) {
          const baseDetails =
            tc.details && typeof tc.details === 'object'
              ? (tc.details as unknown as Record<string, unknown>)
              : {}
          const updated: ToolCallRecord = {
            ...tc,
            status: cancelled ? 'failed' : result.exitCode === 0 ? 'completed' : 'failed',
            outputSummary: cancelled ? 'cancelled by user' : `exit ${result.exitCode}`,
            details: {
              ...baseDetails,
              exitCode: result.exitCode,
              ...(cancelled ? { cancelledByUser: true } : {})
            } as unknown as ToolCallRecord['details'],
            ...(cancelled
              ? { error: 'Background task was cancelled by the user.' }
              : result.exitCode !== 0
                ? { error: `Command exited with code ${result.exitCode}.` }
                : {}),
            finishedAt: timestamp
          }
          this.deps.storage.updateToolCall(updated)
          this.deps.emit<ToolCallUpdatedEvent>({
            type: 'tool.updated',
            threadId: result.threadId,
            runId: tc.runId,
            toolCall: updated
          })
        }
      }

      // 2. Emit background task completion event for the renderer/notifications.
      this.deps.emit<BackgroundTaskCompletedEvent>({
        type: 'background-task.completed',
        threadId: result.threadId,
        taskId: result.taskId,
        command: result.command,
        logPath: result.logPath,
        exitCode: result.exitCode,
        toolCallId: result.toolCallId,
        ...(cancelled ? { cancelledByUser: true } : {})
      })

      // 3. Auto-deliver the completion notice as a regular user message via sendChat,
      // for local threads and owner DMs. Skip when the user manually cancelled —
      // they already know, and triggering a model run would be noise.
      const ctx = this.backgroundTaskRunContext.get(result.taskId)
      this.backgroundTaskRunContext.delete(result.taskId)
      if (!cancelled) {
        void this.autoDeliverBackgroundCompletion(result, ctx)
      }
    } catch (error) {
      // Thread may have been deleted while background task was running
      console.warn('[yachiyo][background-bash] completion handler failed', {
        taskId: result.taskId,
        threadId: result.threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async autoDeliverBackgroundCompletion(
    result: BackgroundBashTaskResult,
    ctx:
      | {
          enabledTools: ToolCallName[]
          enabledSkillNames?: string[]
          channelHint?: string
          extraTools?: import('ai').ToolSet
        }
      | undefined
  ): Promise<void> {
    let thread: ThreadRecord
    try {
      thread = this.deps.requireThread(result.threadId)
    } catch {
      // Thread was deleted between launch and completion. Nothing to do.
      return
    }

    if (!this.isAutoDeliveryEligible(thread)) {
      return
    }

    const content =
      `[Background task completed]\n` +
      `Task ID: ${result.taskId}\n` +
      `Command: ${result.command}\n` +
      `Exit code: ${result.exitCode}\n` +
      `Log file: ${result.logPath}\n\n` +
      `The background command has finished. You can read the log file for full output.`
    const chatOptions = {
      threadId: thread.id,
      content,
      ...(ctx?.enabledTools ? { enabledTools: ctx.enabledTools } : {}),
      ...(ctx?.enabledSkillNames ? { enabledSkillNames: ctx.enabledSkillNames } : {}),
      ...(ctx?.channelHint ? { channelHint: ctx.channelHint } : {}),
      ...(ctx?.extraTools ? { extraTools: ctx.extraTools } : {})
    }
    try {
      // Prefer steer so the completion notice is injected into the active run's
      // context at the next turn boundary instead of spawning a separate run.
      // Falls back to follow-up when no active run exists or the steer is rejected.
      await this.sendChat({ ...chatOptions, mode: 'steer' as SendChatMode })
    } catch {
      // Steer rejected (no active run, or handoff not ready) — fall back to
      // follow-up which queues gracefully or starts a fresh run.
      try {
        await this.sendChat({ ...chatOptions, mode: 'follow-up' })
      } catch (error) {
        console.warn('[yachiyo][background-bash] auto-delivery sendChat failed', {
          threadId: thread.id,
          taskId: result.taskId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  /**
   * Local threads and owner DMs get auto-delivery; group/guest channels do not (they
   * would speak unprompted in someone else's room).
   */
  private isAutoDeliveryEligible(thread: ThreadRecord): boolean {
    const source = thread.source
    if (source == null || source === 'local') return true
    return this.isOwnerDmThread(thread)
  }

  private isOwnerDmThread(thread: ThreadRecord): boolean {
    const source = thread.source
    if (source == null || source === 'local') return false
    if (thread.channelGroupId) return false
    if (!thread.channelUserId) return false
    const user = this.deps.storage.getChannelUser(thread.channelUserId)
    return user?.role === 'owner'
  }

  prepareRecoveredQueuedFollowUps(): string[] {
    return this.deps.storage
      .bootstrap()
      .threads.filter((thread) => thread.queuedFollowUpMessageId)
      .map((thread) => thread.id)
  }

  prepareRecoveredRuns(): RunRecoveryCheckpoint[] {
    return this.deps.storage.listRunRecoveryCheckpoints().filter((checkpoint) => {
      if (this.activeRunByThread.has(checkpoint.threadId)) {
        return false
      }
      const run = this.deps.storage.getRun(checkpoint.runId)
      if (!run || run.status !== 'running') {
        this.deps.storage.deleteRunRecoveryCheckpoint(checkpoint.runId)
        return false
      }
      return true
    })
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

  scheduleRecoveredRuns(checkpoints: RunRecoveryCheckpoint[]): void {
    if (checkpoints.length === 0) {
      return
    }

    setTimeout(() => {
      for (const checkpoint of checkpoints) {
        this.startRecoveredRun(checkpoint)
      }
    }, 0)
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
    const content = rawContent
    const rawMode = input.mode ?? 'normal'
    // ACP threads do not support steer; any steer is treated as follow-up instead.
    const mode: SendChatMode =
      rawMode === 'steer' && thread.runtimeBinding?.kind === 'acp' ? 'follow-up' : rawMode
    const debounceKey = this.createDebouncedSendChatKey({
      attachments: input.attachments,
      channelHint: input.channelHint,
      content,
      enabledSkillNames,
      enabledTools,
      extraTools: input.extraTools,
      images,
      mode,
      threadId: thread.id
    })

    return this.runDebouncedSendChat(debounceKey, thread.id, async () => {
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

      let activeRunId = this.activeRunByThread.get(thread.id)

      if (activeRunId) {
        const activeRun = this.activeRuns.get(activeRunId)
        if (activeRun?.recap) {
          activeRun.abortController.abort()
          activeRunId = undefined
        }
      }

      if (!activeRunId) {
        return this.startFreshRun({
          content,
          enabledTools,
          enabledSkillNames,
          channelHint: input.channelHint,
          extraTools: input.extraTools as import('ai').ToolSet | undefined,
          images: enrichedImages,
          attachments: fileAttachments,
          messageId,
          thread
        })
      }

      if (mode === 'steer') {
        const activeRun = this.activeRuns.get(activeRunId)
        if (!activeRun?.requestMessageId) {
          throw new Error('Wait for the handoff to finish before sending a new message.')
        }
        // Race guard: stop was already clicked, but the tool's long-running
        // interval hasn't observed the abort yet. Writing pendingSteerInput now
        // would attach it to a run heading down the plain-cancelled path, where
        // it gets wiped when activeRuns is cleared. Route the steer through the
        // follow-up queue so startQueuedFollowUpIfPresent picks it up.
        if (activeRun.abortController.signal.aborted) {
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
    })
  }

  async retryMessage(input: RetryInput): Promise<RetryAccepted> {
    const thread = this.deps.requireThread(input.threadId)
    if (!getThreadCapabilities(thread).canRetry) {
      throw new Error('ACP threads do not support retry.')
    }
    if (this.hasNonRecapActiveRun(thread.id)) {
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
    if (this.hasNonRecapActiveRun(input.sourceThread.id)) {
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
      sourceThreadId: input.sourceThread.id,
      sourceMessages: effectiveMessages
    })

    return {
      runId,
      sourceThreadId: input.sourceThread.id,
      thread: input.destinationThread
    }
  }

  async requestRecap(input: { threadId: string }): Promise<string | null> {
    try {
      const thread = this.deps.requireThread(input.threadId)
      if (this.activeRunByThread.has(input.threadId)) return null

      const messages = this.deps.loadThreadMessages(input.threadId)
      const lastPromptTokens =
        this.deps.storage.listThreadRuns(input.threadId)[0]?.promptTokens ?? 0
      if (messages.length <= 5 && lastPromptTokens <= 32_000) return null

      const runId = this.deps.createId()
      const messageId = this.deps.createId()
      const timestamp = this.deps.timestamp()

      const recapUserMessage: MessageRecord = {
        id: messageId,
        threadId: thread.id,
        parentMessageId: thread.headMessageId,
        role: 'user',
        content:
          'Quick recap — no deep thinking needed. The user stepped away and is coming back. Summarize in under 40 words, 1-2 plain sentences, no markdown. Match the language used in the conversation. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.',
        hidden: true,
        status: 'completed',
        createdAt: timestamp
      }

      const enabledTools = resolveEnabledTools(undefined, this.deps.readConfig().enabledTools)

      return new Promise<string | null>((resolve) => {
        this.startActiveRun({
          enabledTools,
          runId,
          thread,
          requestMessageId: messageId,
          updateHeadOnComplete: false,
          recap: true
        })

        const activeRun = this.activeRuns.get(runId)
        if (activeRun) {
          activeRun.recapResolve = resolve
          activeRun.recapUserMessage = recapUserMessage
        } else {
          resolve(null)
        }
      })
    } catch {
      return null
    }
  }

  cancelRun(input: { runId: string }): void {
    const activeRun = this.activeRuns.get(input.runId)
    if (activeRun) {
      // If there's a pending steer, pass it through the abort reason so the
      // catch block in executeServerRun can persist the stopped assistant
      // message first, then the run loop parents the steer under it — keeping
      // the ancestor chain intact for future LLM context assembly.
      //
      // Do NOT clear pendingSteerInput here — it must survive as a fallback
      // for race conditions where executeServerRun returns 'steer-pending'
      // (model finished before observing the abort). The steer-pending handler
      // and the cancelled-with-steer handler each clear it after persisting.
      if (activeRun.pendingSteerInput) {
        const steerInput = {
          content: activeRun.pendingSteerInput.content,
          images: activeRun.pendingSteerInput.images,
          attachments: activeRun.pendingSteerInput.attachments,
          messageId: activeRun.pendingSteerInput.messageId,
          timestamp: activeRun.pendingSteerInput.timestamp,
          hidden: activeRun.pendingSteerInput.hidden
        }
        activeRun.abortController.abort({ type: 'cancel-with-steer', steerInput })
        return
      }

      activeRun.abortController.abort()
      return
    }

    const persistedRun = this.deps.storage.getRun(input.runId)
    if (!persistedRun || persistedRun.status !== 'running') {
      return
    }

    this.deps.storage.cancelRun({
      runId: input.runId,
      completedAt: this.deps.timestamp()
    })
    this.deps.emit<RunCancelledEvent>({
      type: 'run.cancelled',
      threadId: persistedRun.threadId,
      runId: input.runId
    })
  }

  /** Cancel the active run for a thread, if any. Returns true if a run was cancelled. */
  cancelRunForThread(threadId: string): boolean {
    const runId = this.activeRunByThread.get(threadId)
    if (!runId) {
      return false
    }
    this.cancelRun({ runId })
    return true
  }

  /** Discard the pending steer for a thread without cancelling the run. */
  withdrawPendingSteer(threadId: string): void {
    const runId = this.activeRunByThread.get(threadId)
    if (!runId) return
    const activeRun = this.activeRuns.get(runId)
    if (!activeRun?.pendingSteerInput) return
    // Restore the skill override the steer replaced so the live run
    // continues with its original configuration.
    activeRun.enabledSkillNames = activeRun.pendingSteerInput.previousEnabledSkillNames
    activeRun.pendingSteerInput = undefined
    activeRun.pendingSteerMessageId = undefined
  }

  /** Cancel any active run owned by the given channel user. Returns true if a run was cancelled. */
  cancelRunForChannelUser(channelUserId: string): boolean {
    for (const [threadId] of this.activeRunByThread) {
      const thread = this.deps.storage.getThread(threadId)
      if (thread?.channelUserId === channelUserId) {
        return this.cancelRunForThread(threadId)
      }
    }
    return false
  }

  answerToolQuestion(input: { runId: string; toolCallId: string; answer: string }): void {
    const activeRun = this.activeRuns.get(input.runId)
    if (activeRun?.answerToolQuestion) {
      activeRun.answerToolQuestion(input.toolCallId, input.answer)
    }
  }

  private startFreshRun(input: {
    content: string
    enabledTools: ToolCallName[]
    enabledSkillNames?: string[]
    channelHint?: string
    extraTools?: import('ai').ToolSet
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    thread: ThreadRecord
    /** When true, the user message is hidden from the chat timeline (system-initiated). */
    hidden?: boolean
    /** Override the parent message for the new user message (defaults to thread.headMessageId). */
    parentMessageId?: string
  }): ChatAccepted {
    const timestamp = this.deps.timestamp()
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
    const userMessage = this.createUserMessage({
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
    // Emit user message so the renderer can display it in real-time
    // (especially important for external/channel threads where sendChat is
    // called server-side and the renderer doesn't receive the IPC response).
    this.deps.emit<MessageCompletedEvent>({
      type: 'message.completed',
      threadId: accepted.thread.id,
      runId: accepted.runId,
      message: userMessage
    })
    this.deps.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: accepted.thread.id,
      runId: accepted.runId,
      requestMessageId: userMessage.id
    })

    if (!input.hidden && fallbackTitle && fallbackTitle !== DEFAULT_THREAD_TITLE && input.content) {
      this.scheduleThreadTitleGeneration({
        fallbackTitle,
        query: buildTitleQuery(input.content, input.images, input.attachments),
        runId: accepted.runId,
        threadId: accepted.thread.id
      })
    }

    this.startActiveRun({
      enabledTools: input.enabledTools,
      enabledSkillNames: input.enabledSkillNames,
      channelHint: input.channelHint,
      extraTools: input.extraTools,
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
    hidden?: boolean
  }): ChatAccepted {
    const activeRun = this.activeRuns.get(input.activeRunId)
    if (!activeRun) {
      throw new Error('This thread no longer has an active run.')
    }

    // Always queue the steer — it will be applied at the next turn boundary
    // (step boundary via stopWhen, or after the assistant message completes).
    // Never abort the current generation for a steer.
    const previousEnabledSkillNames = activeRun.enabledSkillNames
    activeRun.enabledSkillNames = input.enabledSkillNames ? [...input.enabledSkillNames] : undefined

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
        hidden: activeRun.pendingSteerInput.hidden
      }
    } else {
      activeRun.pendingSteerInput = {
        content: input.content,
        images: input.images,
        attachments: input.attachments,
        messageId: input.messageId,
        timestamp: this.deps.timestamp(),
        previousEnabledSkillNames,
        hidden: input.hidden
      }
    }

    return {
      kind: 'active-run-steer-pending',
      runId: input.activeRunId,
      thread: input.thread
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
    const previousQueuedMessage = previousQueuedMessageId
      ? this.deps
          .loadThreadMessages(input.thread.id)
          .find((message) => message.id === previousQueuedMessageId)
      : undefined
    const mergedContent = previousQueuedMessage
      ? [previousQueuedMessage.content, input.content].filter((part) => part.length > 0).join('\n')
      : input.content
    const mergedImages = previousQueuedMessage
      ? [...(previousQueuedMessage.images ?? []), ...(input.images ?? [])]
      : input.images
    const mergedAttachments = previousQueuedMessage
      ? [...(previousQueuedMessage.attachments ?? []), ...input.attachments]
      : input.attachments
    const userMessage = this.createUserMessage({
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
    this.deps.emit<MessageCompletedEvent>({
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

  private runDebouncedSendChat(
    debounceKey: string | null,
    threadId: string,
    execute: () => Promise<ChatAccepted>
  ): Promise<ChatAccepted> {
    if (!debounceKey) {
      return execute()
    }

    const nowMs = this.getCurrentTimestampMs()
    this.pruneExpiredDebouncedSendChats(nowMs)

    const existing = this.debouncedSendChats.get(debounceKey)
    if (existing && existing.expiresAt > nowMs) {
      if (existing.stateSignature) {
        const currentStateSignature = this.createDebouncedSendChatStateSignature(threadId)
        if (existing.stateSignature !== currentStateSignature) {
          this.debouncedSendChats.delete(debounceKey)
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
      const current = this.debouncedSendChats.get(debounceKey)
      if (current?.promise === promise) {
        this.debouncedSendChats.delete(debounceKey)
      }
      throw error
    })

    this.debouncedSendChats.set(debounceKey, {
      expiresAt: nowMs + SEND_CHAT_DEBOUNCE_WINDOW_MS,
      promise
    })

    void promise.then(() => {
      const current = this.debouncedSendChats.get(debounceKey)
      if (current?.promise === promise) {
        current.stateSignature = this.createDebouncedSendChatStateSignature(threadId)
      }
    })

    return promise
  }

  private createDebouncedSendChatKey(input: {
    attachments?: SendChatInput['attachments']
    channelHint?: string
    content: string
    enabledSkillNames?: string[]
    enabledTools: ToolCallName[]
    extraTools?: SendChatInput['extraTools']
    images: MessageRecord['images']
    mode: SendChatMode
    threadId: string
  }): string | null {
    if (input.extraTools) {
      return null
    }

    return JSON.stringify({
      attachments:
        input.attachments?.map((attachment) => ({
          dataUrl: attachment.dataUrl,
          filename: attachment.filename,
          mediaType: attachment.mediaType
        })) ?? [],
      channelHint: input.channelHint ?? null,
      content: input.content,
      enabledSkillNames: input.enabledSkillNames ?? [],
      enabledTools: input.enabledTools,
      images: (input.images ?? []).map((image) => ({
        dataUrl: image.dataUrl,
        filename: image.filename ?? null,
        mediaType: image.mediaType
      })),
      mode: input.mode,
      threadId: input.threadId
    })
  }

  private createDebouncedSendChatStateSignature(threadId: string): string {
    const thread = this.deps.requireThread(threadId)
    const activeRunId = this.activeRunByThread.get(threadId) ?? null
    const activeRun = activeRunId ? this.activeRuns.get(activeRunId) : null

    return JSON.stringify({
      activeRunId,
      executionPhase: activeRun?.executionPhase ?? null,
      headMessageId: thread.headMessageId ?? null,
      pendingSteerMessageId: activeRun?.pendingSteerMessageId ?? null,
      queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
      requestMessageId: activeRun?.requestMessageId ?? null
    })
  }

  private getCurrentTimestampMs(): number {
    const timestampMs = Date.parse(this.deps.timestamp())
    if (Number.isNaN(timestampMs)) {
      throw new Error('Invalid server timestamp.')
    }
    return timestampMs
  }

  private pruneExpiredDebouncedSendChats(nowMs: number): void {
    for (const [debounceKey, entry] of this.debouncedSendChats) {
      if (entry.expiresAt <= nowMs) {
        this.debouncedSendChats.delete(debounceKey)
      }
    }
  }

  private persistSteerMessage(input: {
    content: string
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    runId: string
    runState: RunState
    thread: ThreadRecord
    timestamp: string
    hidden?: boolean
  }): { updatedThread: ThreadRecord; userMessage: MessageRecord } {
    const persistedAt = this.deps.timestamp()
    const userMessage = this.createUserMessage({
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
    this.deps.emit<MessageCompletedEvent>({
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

  private startActiveRun(input: {
    enabledTools: ToolCallName[]
    enabledSkillNames?: string[]
    channelHint?: string
    extraTools?: import('ai').ToolSet
    recoveryCheckpoint?: RunRecoveryCheckpoint
    runId: string
    thread: ThreadRecord
    requestMessageId: string
    updateHeadOnComplete: boolean
    recap?: boolean
  }): void {
    this.activeRuns.set(input.runId, {
      threadId: input.thread.id,
      requestMessageId: input.requestMessageId,
      ...(input.enabledSkillNames ? { enabledSkillNames: [...input.enabledSkillNames] } : {}),
      ...(input.channelHint ? { channelHint: input.channelHint } : {}),
      ...(input.recoveryCheckpoint ? { recoveryCheckpoint: input.recoveryCheckpoint } : {}),
      abortController: new AbortController(),
      executionPhase: 'generating',
      updateHeadOnComplete: input.updateHeadOnComplete,
      ...(input.recap ? { recap: true } : {})
    })
    this.activeRunByThread.set(input.thread.id, input.runId)

    const runTask = this.runLoop({
      enabledTools: input.enabledTools,
      enabledSkillNames: input.enabledSkillNames,
      channelHint: input.channelHint,
      extraTools: input.extraTools,
      recoveryCheckpoint: input.recoveryCheckpoint,
      runId: input.runId,
      thread: input.thread,
      requestMessageId: input.requestMessageId,
      updateHeadOnComplete: input.updateHeadOnComplete
    })
    this.activeRunTasks.set(input.runId, runTask)
    void runTask
  }

  private startRecoveredRun(checkpoint: RunRecoveryCheckpoint): void {
    if (this.isClosing || this.activeRunByThread.has(checkpoint.threadId)) {
      return
    }

    const thread = this.deps.requireThread(checkpoint.threadId)
    const toolCalls = this.deps
      .loadThreadToolCalls(thread.id)
      .filter((toolCall) => toolCall.runId === checkpoint.runId)

    this.deps.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: checkpoint.threadId,
      runId: checkpoint.runId,
      requestMessageId: checkpoint.requestMessageId
    })
    this.deps.emit<MessageStartedEvent>({
      type: 'message.started',
      threadId: checkpoint.threadId,
      runId: checkpoint.runId,
      messageId: checkpoint.assistantMessageId,
      parentMessageId: checkpoint.requestMessageId
    })
    if (checkpoint.reasoning) {
      this.deps.emit<MessageReasoningDeltaEvent>({
        type: 'message.reasoning.delta',
        threadId: checkpoint.threadId,
        runId: checkpoint.runId,
        messageId: checkpoint.assistantMessageId,
        delta: checkpoint.reasoning
      })
    }
    if (checkpoint.content) {
      this.deps.emit<MessageDeltaEvent>({
        type: 'message.delta',
        threadId: checkpoint.threadId,
        runId: checkpoint.runId,
        messageId: checkpoint.assistantMessageId,
        delta: checkpoint.content
      })
    }
    for (const toolCall of toolCalls) {
      this.deps.emit<ToolCallUpdatedEvent>({
        type: 'tool.updated',
        threadId: checkpoint.threadId,
        runId: checkpoint.runId,
        toolCall
      })
    }

    this.activeRuns.set(checkpoint.runId, {
      threadId: checkpoint.threadId,
      requestMessageId: checkpoint.requestMessageId,
      ...(checkpoint.enabledSkillNames
        ? { enabledSkillNames: [...checkpoint.enabledSkillNames] }
        : {}),
      ...(checkpoint.channelHint ? { channelHint: checkpoint.channelHint } : {}),
      recoveryCheckpoint: checkpoint,
      abortController: new AbortController(),
      executionPhase: 'generating',
      updateHeadOnComplete: checkpoint.updateHeadOnComplete
    })
    this.activeRunByThread.set(checkpoint.threadId, checkpoint.runId)

    const runTask = this.runLoop({
      enabledTools: checkpoint.enabledTools,
      enabledSkillNames: checkpoint.enabledSkillNames,
      channelHint: checkpoint.channelHint,
      recoveryCheckpoint: checkpoint,
      runId: checkpoint.runId,
      thread,
      requestMessageId: checkpoint.requestMessageId,
      updateHeadOnComplete: checkpoint.updateHeadOnComplete
    })
    this.activeRunTasks.set(checkpoint.runId, runTask)
    void runTask
  }

  private startAssistantOnlyRun(input: {
    runId: string
    thread: ThreadRecord
    sourceThreadId: string
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
    extraTools?: import('ai').ToolSet
    recoveryCheckpoint?: RunRecoveryCheckpoint
    runId: string
    thread: ThreadRecord
    requestMessageId: string
    updateHeadOnComplete: boolean
  }): Promise<void> {
    let currentThread = input.thread
    let currentRequestMessageId = input.requestMessageId
    let previousEnabledTools = this.lastRunEnabledTools
    let result: ExecuteRunResult = { kind: 'cancelled' }
    let accumulatedUsage: ExecuteRunInput['priorUsage'] | undefined
    let carriedSnapshotTracker: SnapshotTracker | undefined
    let carriedToolFailLoopSteers = 0
    let isSteerLeg = false

    try {
      while (true) {
        const activeRun = this.activeRuns.get(input.runId)
        if (!activeRun) {
          return
        }

        const abortController = new AbortController()
        activeRun.abortController = abortController
        activeRun.requestMessageId = currentRequestMessageId

        if (currentThread.runtimeBinding?.kind === 'acp') {
          result = await runAcpChatThread(
            {
              storage: this.deps.storage,
              createId: this.deps.createId,
              timestamp: this.deps.timestamp,
              emit: this.deps.emit,
              readThread: this.deps.requireThread,
              readConfig: this.deps.readConfig,
              loadThreadMessages: this.deps.loadThreadMessages,
              ensureThreadWorkspace: this.deps.ensureThreadWorkspace,
              onTerminalState: () => {
                this.activeRuns.delete(input.runId)
                this.activeRunByThread.delete(input.thread.id)
                this.activeRunTasks.delete(input.runId)
              }
            },
            {
              runId: input.runId,
              thread: currentThread,
              requestMessageId: currentRequestMessageId,
              abortController,
              updateHeadOnComplete: input.updateHeadOnComplete
            }
          )
          break
        }

        // Clear the carried reference so executeServerRun owns the tracker
        // exclusively — the finally block won't double-dispose a live tracker.
        const passTracker = carriedSnapshotTracker
        carriedSnapshotTracker = undefined
        const threadId = currentThread.id
        if (!this.readRecordCaches.has(threadId)) {
          this.readRecordCaches.set(threadId, new ReadRecordCache())
        }
        const readRecordCache = this.readRecordCaches.get(threadId)!

        const isRecapRun = activeRun?.recap === true
        const recapStorage = isRecapRun
          ? createEphemeralStorageProxy(this.deps.storage)
          : this.deps.storage
        const recapEmit: typeof this.deps.emit = isRecapRun ? () => {} : this.deps.emit

        result = await executeServerRun(
          {
            storage: recapStorage,
            createId: this.deps.createId,
            timestamp: this.deps.timestamp,
            emit: recapEmit,
            createModelRuntime: this.deps.createModelRuntime,
            ensureThreadWorkspace: this.deps.ensureThreadWorkspace,
            buildMemoryLayerEntries: async (context) => {
              if (context.thread.privacyMode || isRecapRun) {
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
            webExternalFetchImpl: this.deps.webExternalFetchImpl,
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
            loadThreadMessages: isRecapRun
              ? (threadId: string) => {
                  const msgs = this.deps.loadThreadMessages(threadId)
                  if (threadId === currentThread.id && activeRun?.recapUserMessage) {
                    return [...msgs, activeRun.recapUserMessage]
                  }
                  return msgs
                }
              : this.deps.loadThreadMessages,
            loadThreadToolCalls: this.deps.loadThreadToolCalls,
            listSkills: this.deps.listSkills,
            jotdownStore: this.deps.jotdownStore,
            imageToTextService: this.deps.imageToTextService,
            isModelImageCapable: (() => {
              const cfg = this.deps.readConfig()
              const effective =
                this.deps.requireThread(currentThread.id).modelOverride ??
                cfg.defaultModel ??
                (() => {
                  const primary =
                    cfg.providers.find((p) => p.modelList.enabled.length > 0) ?? cfg.providers[0]
                  return primary
                    ? { providerName: primary.name, model: primary.modelList.enabled[0] ?? '' }
                    : undefined
                })()
              if (!effective) return true
              return isModelImageCapable(cfg, effective.providerName, effective.model)
            })(),
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
            onAskUserHandlerReady: (handler) => {
              const currentRun = this.activeRuns.get(input.runId)
              if (currentRun) {
                currentRun.answerToolQuestion = handler
              }
            },
            hasPendingSteer: () => {
              const currentRun = this.activeRuns.get(input.runId)
              return currentRun?.pendingSteerInput != null
            },
            injectPendingSteer: (steerInput) => {
              const activeRun = this.activeRuns.get(input.runId)
              if (!activeRun) {
                return
              }
              this.sendActiveRunSteer({
                activeRunId: input.runId,
                content: steerInput.content,
                enabledSkillNames: activeRun.enabledSkillNames,
                images: [],
                attachments: [],
                messageId: this.deps.createId(),
                thread: currentThread
              })
            },
            onSubagentProgress: (event) => {
              this.deps.emit<SubagentProgressEvent>({
                type: 'subagent.progress',
                threadId: input.thread.id,
                runId: input.runId,
                delegationId: event.delegationId,
                chunk: event.chunk
              })
            },
            onBackgroundBashStarted: async (task) => {
              // Snapshot the launching run's transport context so we can call sendChat
              // with the same channelHint/extraTools/etc. when the task completes — this
              // is what lets owner-DM auto-delivery actually reach the user via the
              // original channel reply tool. Cleared in `handleBackgroundBashCompleted`.
              this.backgroundTaskRunContext.set(task.taskId, {
                enabledTools: input.enabledTools,
                ...(input.enabledSkillNames ? { enabledSkillNames: input.enabledSkillNames } : {}),
                ...(input.channelHint ? { channelHint: input.channelHint } : {}),
                ...(input.extraTools ? { extraTools: input.extraTools } : {})
              })
              try {
                await this.backgroundBashManager.startTask({
                  ...task,
                  threadId: task.threadId
                })
                this.deps.emit<BackgroundTaskStartedEvent>({
                  type: 'background-task.started',
                  threadId: task.threadId,
                  taskId: task.taskId,
                  command: task.command,
                  startedAt: this.deps.timestamp()
                })
              } catch (error) {
                this.backgroundTaskRunContext.delete(task.taskId)
                throw error
              }
            },
            onBackgroundBashAdopted: async (task) => {
              // Same snapshot/emit dance as the explicit-background path; the only
              // difference is we hand the manager an already-running child instead
              // of letting it spawn one.
              this.backgroundTaskRunContext.set(task.taskId, {
                enabledTools: input.enabledTools,
                ...(input.enabledSkillNames ? { enabledSkillNames: input.enabledSkillNames } : {}),
                ...(input.channelHint ? { channelHint: input.channelHint } : {}),
                ...(input.extraTools ? { extraTools: input.extraTools } : {})
              })
              try {
                await this.backgroundBashManager.adoptTask({
                  taskId: task.taskId,
                  command: task.command,
                  cwd: task.cwd,
                  logPath: task.logPath,
                  ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
                  threadId: task.threadId,
                  child: task.child,
                  initialOutput: task.initialOutput,
                  ...(task.initialOutputAlreadyOnDisk ? { initialOutputAlreadyOnDisk: true } : {})
                })
                this.deps.emit<BackgroundTaskStartedEvent>({
                  type: 'background-task.started',
                  threadId: task.threadId,
                  taskId: task.taskId,
                  command: task.command,
                  startedAt: this.deps.timestamp()
                })
              } catch (error) {
                this.backgroundTaskRunContext.delete(task.taskId)
                throw error
              }
            },
            getCompletedBackgroundBashTask: (taskId) =>
              this.backgroundBashManager.getCompletedTask(taskId),
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
            inactivityTimeoutMs: this.deps.runInactivityTimeoutMs,
            channelHint: activeRun.channelHint ?? input.channelHint,
            extraTools: input.extraTools,
            previousEnabledTools,
            recoveryCheckpoint: activeRun.recoveryCheckpoint ?? input.recoveryCheckpoint,
            requestMessageId: currentRequestMessageId,
            runId: input.runId,
            thread: currentThread,
            updateHeadOnComplete: input.updateHeadOnComplete,
            ...(accumulatedUsage ? { priorUsage: accumulatedUsage } : {}),
            ...(isSteerLeg ? { isSteerLeg: true } : {}),
            ...(carriedToolFailLoopSteers > 0
              ? { priorToolFailLoopSteers: carriedToolFailLoopSteers }
              : {}),
            ...(passTracker ? { snapshotTracker: passTracker } : {}),
            ...(isRecapRun ? { maxToolStepsOverride: 0 } : {}),
            readRecordCache
          }
        )

        previousEnabledTools = input.enabledTools

        if (result.kind === 'recovering') {
          activeRun.recoveryCheckpoint = result.checkpoint
          activeRun.recoveringHarnessId = result.harnessId
          try {
            await sleep(
              Math.min(1_000 * 2 ** Math.max(0, result.checkpoint.recoveryAttempts - 1), 30_000),
              activeRun.abortController.signal
            )
          } catch (error) {
            if (!isAbortError(error)) {
              throw error
            }

            const timestamp = this.deps.timestamp()
            const checkpoint = activeRun.recoveryCheckpoint
            if (
              checkpoint &&
              (checkpoint.content || checkpoint.reasoning || checkpoint.textBlocks?.length)
            ) {
              const stoppedMessage: MessageRecord = {
                id: checkpoint.assistantMessageId,
                threadId: checkpoint.threadId,
                parentMessageId: checkpoint.requestMessageId,
                role: 'assistant',
                content: checkpoint.content,
                ...(checkpoint.reasoning ? { reasoning: checkpoint.reasoning } : {}),
                ...(checkpoint.textBlocks?.length ? { textBlocks: checkpoint.textBlocks } : {}),
                status: 'stopped',
                createdAt: timestamp
              }
              const latestThread = this.deps.requireThread(checkpoint.threadId)
              const updatedThread: ThreadRecord = {
                ...latestThread,
                updatedAt: timestamp,
                ...(checkpoint.updateHeadOnComplete
                  ? { headMessageId: checkpoint.assistantMessageId }
                  : {}),
                ...(checkpoint.content ? { preview: checkpoint.content.slice(0, 240) } : {})
              }
              this.deps.storage.saveThreadMessage({
                thread: latestThread,
                updatedThread,
                message: stoppedMessage
              })
              this.bindTerminalToolCallsToAssistant({
                threadId: checkpoint.threadId,
                runId: input.runId,
                assistantMessageId: checkpoint.assistantMessageId
              })
              this.deps.emit<MessageCompletedEvent>({
                type: 'message.completed',
                threadId: checkpoint.threadId,
                runId: input.runId,
                message: stoppedMessage
              })
              this.deps.emit<ThreadUpdatedEvent>({
                type: 'thread.updated',
                threadId: checkpoint.threadId,
                thread: updatedThread
              })
            }
            this.deps.storage.cancelRun({
              runId: input.runId,
              completedAt: timestamp,
              ...usageFieldsFrom(accumulatedUsage)
            })
            this.emitCancelledHarnessFinished({
              threadId: input.thread.id,
              runId: input.runId,
              harnessId: activeRun.recoveringHarnessId
            })
            this.deps.emit<RunCancelledEvent>({
              type: 'run.cancelled',
              threadId: input.thread.id,
              runId: input.runId,
              requestMessageId: currentRequestMessageId
            })
            result = { kind: 'cancelled' }
            break
          }
          continue
        }

        activeRun.recoveryCheckpoint = undefined
        activeRun.recoveringHarnessId = undefined

        if (result.kind === 'completed') {
          if (isRecapRun) {
            const text = (recapStorage as EphemeralStorage).lastAssistantContent ?? null
            if (text) {
              const thread = this.deps.storage.getThread(currentThread.id)
              if (thread) {
                this.deps.storage.updateThread({ ...thread, recapText: text })
              }
            }
            activeRun?.recapResolve?.(text)
            activeRun!.recapResolve = undefined
            this.deps.emit<RunCompletedEvent>({
              type: 'run.completed',
              threadId: input.thread.id,
              runId: input.runId,
              requestMessageId: currentRequestMessageId,
              recap: true
            })
            break
          }
          // Re-read the persisted thread so headMessageId reflects the
          // assistant reply, not the pre-run snapshot.
          const persistedThread = this.deps.storage.getThread(currentThread.id)
          if (persistedThread) {
            this.memoryScheduler.onRunCompleted(persistedThread, result.usedRememberTool)
          }
        }

        // Safe steer: the stream ended cleanly at a turn boundary and a user
        // steer is waiting. Persist the steer message and continue the loop
        // so the next executeServerRun iteration starts from the steer.
        if (result.kind === 'steer-pending') {
          carriedSnapshotTracker = result.snapshotTracker
          if (!activeRun?.pendingSteerInput) {
            // The steer was cancelled (e.g. user stopped the run) while the
            // model was finishing. The cancel path in executeServerRun never ran
            // (the abort arrived after throwIfAborted), so we must cancel the
            // run in storage ourselves and let the finally block fire
            // startQueuedFollowUpIfPresent.
            carriedSnapshotTracker?.dispose()
            carriedSnapshotTracker = undefined
            const steerPendingUsage = mergeUsageForTerminal(accumulatedUsage, result.usage)
            this.deps.storage.cancelRun({
              runId: input.runId,
              completedAt: this.deps.timestamp(),
              ...usageFieldsFrom(steerPendingUsage)
            })
            this.deps.emit<RunCancelledEvent>({
              type: 'run.cancelled',
              threadId: input.thread.id,
              runId: input.runId,
              requestMessageId: currentRequestMessageId
            })
            result = { kind: 'cancelled' }
            break
          }

          // Point requestMessageId to the completed assistant message so
          // persistSteerMessage parents the steer as a child of the assistant
          // response — not a sibling. This ensures the model sees all previous
          // work (including tool calls and results) when processing the steer.
          activeRun.requestMessageId = result.assistantMessageId

          const steerThread = this.deps.requireThread(input.thread.id)
          const { userMessage } = this.persistSteerMessage({
            content: activeRun.pendingSteerInput.content,
            images: activeRun.pendingSteerInput.images,
            attachments: activeRun.pendingSteerInput.attachments,
            messageId: activeRun.pendingSteerInput.messageId,
            runId: input.runId,
            runState: activeRun,
            thread: steerThread,
            timestamp: activeRun.pendingSteerInput.timestamp,
            hidden: activeRun.pendingSteerInput.hidden
          })

          this.emitThreadStateReplaced(input.thread.id)
          activeRun.pendingSteerInput = undefined
          activeRun.pendingSteerMessageId = undefined
          activeRun.executionPhase = 'generating'
          activeRun.requestMessageId = userMessage.id
          currentRequestMessageId = userMessage.id
          this.deps.storage.updateRunRequestMessageId(input.runId, userMessage.id)
          currentThread = this.deps.requireThread(input.thread.id)

          // Accumulate totals from this steer leg so the final completion
          // includes total token counts from all legs of the run.
          if (result.usage) {
            const u = result.usage
            accumulatedUsage = {
              promptTokens: u.promptTokens,
              completionTokens: (accumulatedUsage?.completionTokens ?? 0) + u.completionTokens,
              totalPromptTokens: (accumulatedUsage?.totalPromptTokens ?? 0) + u.totalPromptTokens,
              totalCompletionTokens:
                (accumulatedUsage?.totalCompletionTokens ?? 0) + u.totalCompletionTokens,
              cacheReadTokens: (accumulatedUsage?.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
              cacheWriteTokens:
                (accumulatedUsage?.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0)
            }
          }
          carriedToolFailLoopSteers = result.toolFailLoopSteersInjected ?? carriedToolFailLoopSteers
          isSteerLeg = true
          continue
        }

        // Cancel-with-steer: the stopped assistant message has been persisted
        // by executeServerRun. Now persist the steer message as its child and
        // queue it as a follow-up so startQueuedFollowUpIfPresent fires a new run.
        //
        // Guard: if pendingSteerInput was already cleared by a prior
        // steer-pending iteration (race: model finished before observing the
        // abort), the steer is already persisted — skip to avoid double-persist.
        if (result.kind === 'cancelled-with-steer') {
          if (activeRun.pendingSteerInput) {
            const steerThread = this.deps.requireThread(input.thread.id)
            const { updatedThread, userMessage } = this.persistSteerMessage({
              content: result.steerInput.content,
              images: result.steerInput.images,
              attachments: result.steerInput.attachments,
              messageId: result.steerInput.messageId,
              runId: input.runId,
              runState: { ...activeRun, requestMessageId: result.stoppedMessageId },
              thread: steerThread,
              timestamp: result.steerInput.timestamp,
              hidden: result.steerInput.hidden
            })
            const queuedThread: ThreadRecord = {
              ...updatedThread,
              queuedFollowUpMessageId: userMessage.id
            }
            this.deps.storage.updateThread(queuedThread)
            this.emitThreadStateReplaced(input.thread.id)
            activeRun.pendingSteerInput = undefined
          }
          result = { kind: 'cancelled', usage: result.usage }
          break
        }

        if (isRecapRun && (result.kind === 'cancelled' || result.kind === 'failed')) {
          activeRun?.recapResolve?.(null)
          activeRun!.recapResolve = undefined
          this.deps.emit<RunCancelledEvent>({
            type: 'run.cancelled',
            threadId: input.thread.id,
            runId: input.runId,
            requestMessageId: currentRequestMessageId,
            recap: true
          })
          break
        }

        if (result.kind !== 'restarted') {
          break
        }

        carriedSnapshotTracker = result.snapshotTracker
        // Accumulate totals from the restarted leg so they aren't lost if the
        // subsequent leg is cancelled or fails.
        if (result.usage) {
          const u = result.usage
          accumulatedUsage = {
            promptTokens: u.promptTokens,
            completionTokens: (accumulatedUsage?.completionTokens ?? 0) + u.completionTokens,
            totalPromptTokens: (accumulatedUsage?.totalPromptTokens ?? 0) + u.totalPromptTokens,
            totalCompletionTokens:
              (accumulatedUsage?.totalCompletionTokens ?? 0) + u.totalCompletionTokens,
            cacheReadTokens: (accumulatedUsage?.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
            cacheWriteTokens: (accumulatedUsage?.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0)
          }
        }

        const nextRequestMessageId = activeRun.pendingSteerMessageId ?? result.nextRequestMessageId

        activeRun.pendingSteerMessageId = undefined
        activeRun.pendingSteerInput = undefined
        activeRun.executionPhase = 'generating'
        activeRun.requestMessageId = nextRequestMessageId
        currentRequestMessageId = nextRequestMessageId
        this.deps.storage.updateRunRequestMessageId(input.runId, nextRequestMessageId)
        currentThread = this.deps.requireThread(input.thread.id)
        isSteerLeg = true
        this.emitThreadStateReplaced(currentThread.id)
      }
    } catch (error) {
      const recapRun = this.activeRuns.get(input.runId)
      if (recapRun?.recap) {
        recapRun.recapResolve?.(null)
        recapRun.recapResolve = undefined
        this.deps.emit<RunCancelledEvent>({
          type: 'run.cancelled',
          threadId: input.thread.id,
          runId: input.runId,
          requestMessageId: currentRequestMessageId,
          recap: true
        })
        result = { kind: 'failed' }
      } else {
        const persistedRun = this.deps.storage.getRun(input.runId)

        if (!persistedRun || persistedRun.status !== 'running') {
          throw error
        }

        const timestamp = this.deps.timestamp()
        const message = error instanceof Error ? error.message : String(error)
        this.deps.storage.failRun({
          runId: input.runId,
          completedAt: timestamp,
          error: message,
          ...usageFieldsFrom(accumulatedUsage)
        })
        this.deps.emit<RunFailedEvent>({
          type: 'run.failed',
          threadId: input.thread.id,
          runId: input.runId,
          error: message
        })
        result = { kind: 'failed' }
      }
    } finally {
      // Resolve any dangling recap promise on cancellation/unexpected exit.
      const finalRun = this.activeRuns.get(input.runId)
      if (finalRun?.recapResolve) {
        finalRun.recapResolve(null)
        finalRun.recapResolve = undefined
      }

      // Dispose the carried tracker if it wasn't consumed by the next leg
      // (e.g. the loop exited via catch or the run was cancelled between legs).
      carriedSnapshotTracker?.dispose()
      carriedSnapshotTracker = undefined

      this.activeRuns.delete(input.runId)
      if (this.activeRunByThread.get(input.thread.id) === input.runId) {
        this.activeRunByThread.delete(input.thread.id)
      }
      this.activeRunTasks.delete(input.runId)

      const wasRecap = finalRun?.recap === true
      if (
        !wasRecap &&
        !this.isClosing &&
        result.kind !== 'restarted' &&
        result.kind !== 'steer-pending'
      ) {
        this.startQueuedFollowUpIfPresent(input.thread.id)
      }
    }
  }

  private async streamCompactThreadHandoff(input: {
    runId: string
    thread: ThreadRecord
    sourceThreadId: string
    sourceMessages: MessageRecord[]
  }): Promise<void> {
    const config = this.deps.readConfig()
    const settings = toEffectiveProviderSettings(config, input.thread.modelOverride)
    const runtime = this.deps.createModelRuntime()
    const messageId = this.deps.createId()
    const bufferParts: string[] = []
    const reasoningParts: string[] = []
    let reasoningLength = 0
    const DELTA_FLUSH_INTERVAL_MS = 20

    this.deps.emit<MessageStartedEvent>({
      type: 'message.started',
      threadId: input.thread.id,
      runId: input.runId,
      messageId
    })

    const activeRun = this.activeRuns.get(input.runId)
    if (!activeRun) {
      return
    }

    const textDeltaBatcher = createDeltaBatcher({
      intervalMs: DELTA_FLUSH_INTERVAL_MS,
      onFlush: (batch) => {
        bufferParts.push(batch)
        this.deps.emit<MessageDeltaEvent>({
          type: 'message.delta',
          threadId: input.thread.id,
          runId: input.runId,
          messageId,
          delta: batch
        })
      },
      isAborted: () => activeRun.abortController.signal.aborted
    })

    const reasoningDeltaBatcher = createDeltaBatcher({
      intervalMs: DELTA_FLUSH_INTERVAL_MS,
      onFlush: (batch) => {
        reasoningParts.push(batch)
        reasoningLength += batch.length
        this.deps.emit<MessageReasoningDeltaEvent>({
          type: 'message.reasoning.delta',
          threadId: input.thread.id,
          runId: input.runId,
          messageId,
          delta: batch
        })
      },
      isAborted: () => activeRun.abortController.signal.aborted
    })

    try {
      const sourceThread = this.deps.requireThread(input.sourceThreadId)
      const sourceTurnContext = findLatestUserTurnContext(input.sourceMessages)
      const handoffRequestId = this.deps.createId()
      const handoffRequestMessage: MessageRecord = {
        id: handoffRequestId,
        threadId: sourceThread.id,
        role: 'user',
        content: buildThreadHandoffPrompt(input.sourceMessages.length > 0),
        status: 'completed',
        createdAt: this.deps.timestamp()
      }
      const sourceEnabledTools =
        sourceTurnContext?.enabledTools ?? resolveEnabledTools(undefined, config.enabledTools)
      const preparedContext = await prepareServerRunContext(
        {
          storage: this.deps.storage,
          createId: this.deps.createId,
          timestamp: this.deps.timestamp,
          emit: this.deps.emit,
          createModelRuntime: this.deps.createModelRuntime,
          ensureThreadWorkspace: this.deps.ensureThreadWorkspace,
          fetchImpl: this.deps.fetchImpl,
          webExternalFetchImpl: this.deps.webExternalFetchImpl,
          loadBrowserSnapshot: this.deps.loadBrowserSnapshot,
          memoryService: this.deps.memoryService,
          searchService: this.deps.searchService,
          webSearchService: this.deps.webSearchService,
          readSoulDocument: this.deps.readSoulDocument,
          readUserDocument: this.deps.readUserDocument,
          readThread: this.deps.requireThread,
          readConfig: this.deps.readConfig,
          readSettings: () => settings,
          loadThreadMessages: this.deps.loadThreadMessages,
          loadThreadToolCalls: this.deps.loadThreadToolCalls,
          listSkills: this.deps.listSkills,
          onEnabledToolsUsed: () => undefined,
          jotdownStore: this.deps.jotdownStore,
          imageToTextService: this.deps.imageToTextService,
          isModelImageCapable: isModelImageCapable(config, settings.providerName, settings.model)
        },
        {
          runId: input.runId,
          thread: sourceThread,
          requestMessageId: handoffRequestId,
          requestMessage: handoffRequestMessage,
          historyMessages: [...input.sourceMessages, handoffRequestMessage],
          enabledTools: sourceEnabledTools,
          ...(sourceTurnContext?.enabledSkillNames !== undefined
            ? { enabledSkillNames: sourceTurnContext.enabledSkillNames }
            : {}),
          abortController: activeRun.abortController,
          persistTurnContext: false,
          emitContextEvents: false,
          includeMemoryRecall: false,
          applyStripCompact: false
        }
      )
      const handoffTools = disableHandoffToolExecution(
        createAgentToolSet(
          {
            enabledTools: preparedContext.modelEnabledTools,
            workspacePath: preparedContext.workspacePath,
            sandboxed: preparedContext.isExternalChannel && !preparedContext.isOwnerDm,
            readRecordCache: new ReadRecordCache(),
            imageToTextService: this.deps.imageToTextService,
            isModelImageCapable: isModelImageCapable(config, settings.providerName, settings.model)
          },
          {
            availableSkills: preparedContext.availableSkills,
            fetchImpl: this.deps.webExternalFetchImpl ?? this.deps.fetchImpl,
            loadBrowserSnapshot: this.deps.loadBrowserSnapshot,
            searchService: this.deps.searchService,
            memoryService: sourceThread.privacyMode ? undefined : this.deps.memoryService,
            webSearchService: this.deps.webSearchService,
            updateProfileDeps: {
              userDocumentPath: preparedContext.isGuest
                ? resolveYachiyoUserPath(preparedContext.workspacePath)
                : resolveYachiyoUserPath(),
              ...(preparedContext.isExternalChannel
                ? {
                    userDocumentMode: preparedContext.isGuest
                      ? ('guest' as const)
                      : ('owner' as const)
                  }
                : {})
            },
            ...(!sourceThread.privacyMode &&
            (!preparedContext.isExternalChannel || preparedContext.isOwnerDm) &&
            this.deps.memoryService.isConfigured()
              ? { rememberDeps: { memoryService: this.deps.memoryService } }
              : {}),
            ...(!sourceThread.privacyMode &&
            (!preparedContext.isExternalChannel || preparedContext.isOwnerDm)
              ? {
                  crossThreadSearch: (searchInput: {
                    query: string
                    limit?: number
                    includePrivate?: boolean
                  }) => this.deps.storage.searchThreadsAndMessagesFts(searchInput)
                }
              : {}),
            ...(!preparedContext.isExternalChannel
              ? {
                  askUserContext: {
                    waitForUserAnswer: async () => {
                      throw new Error('Tool execution is disabled during handoff creation.')
                    }
                  }
                }
              : {}),
            ...((preparedContext.gitCtx.hasGit ||
              preparedContext.gitValidatedWorkspaces.length > 0) &&
            preparedContext.enabledSubagentProfiles.length > 0
              ? {
                  subagentProfiles: preparedContext.enabledSubagentProfiles,
                  availableWorkspaces: preparedContext.gitValidatedWorkspaces
                }
              : {})
          }
        )
      )

      let handoffUsage: ModelUsage | undefined
      for await (const delta of runtime.streamReply({
        messages: preparedContext.messages,
        settings,
        signal: activeRun.abortController.signal,
        purpose: 'thread-handoff',
        promptCacheKey: input.sourceThreadId,
        ...(handoffTools
          ? {
              tools: handoffTools,
              onToolCallError: () => 'abort' as const
            }
          : {}),
        onReasoningDelta: (reasoningDelta) => {
          reasoningDeltaBatcher.push(reasoningDelta)
        },
        onFinish: (usage) => {
          handoffUsage = usage
        }
      })) {
        if (!delta) {
          continue
        }

        textDeltaBatcher.push(delta)
      }

      textDeltaBatcher.flush()
      reasoningDeltaBatcher.flush()

      const timestamp = this.deps.timestamp()
      const handoffResponseMessages = handoffUsage?.responseMessages
        ? (handoffUsage.responseMessages as Array<{ role?: string; content?: unknown[] }>)
            .map((msg) => {
              if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg
              return {
                ...msg,
                content: msg.content.filter(
                  (part) => (part as { type?: string }).type !== 'reasoning'
                )
              }
            })
            .filter(
              (msg) =>
                msg.role !== 'assistant' || !Array.isArray(msg.content) || msg.content.length > 0
            )
        : undefined

      const assistantMessage: MessageRecord = {
        id: messageId,
        threadId: input.thread.id,
        role: 'assistant',
        content: bufferParts.join(''),
        ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
        ...(handoffResponseMessages?.length ? { responseMessages: handoffResponseMessages } : {}),
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
        assistantMessage,
        ...(handoffUsage
          ? {
              promptTokens: handoffUsage.completionTokens,
              completionTokens: handoffUsage.completionTokens,
              totalPromptTokens: handoffUsage.totalCompletionTokens,
              totalCompletionTokens: handoffUsage.totalCompletionTokens,
              ...(handoffUsage.cacheReadTokens != null
                ? { cacheReadTokens: handoffUsage.cacheReadTokens }
                : {}),
              ...(handoffUsage.cacheWriteTokens != null
                ? { cacheWriteTokens: handoffUsage.cacheWriteTokens }
                : {})
            }
          : {})
      })
      this.activeRuns.delete(input.runId)
      this.activeRunByThread.delete(input.thread.id)
      this.activeRunTasks.delete(input.runId)

      if (handoffUsage) {
        this.deps.emit<RunUsageUpdatedEvent>({
          type: 'run.usage.updated',
          threadId: input.thread.id,
          runId: input.runId,
          promptTokens: handoffUsage.completionTokens,
          completionTokens: handoffUsage.completionTokens
        })
      }

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
        runId: input.runId,
        ...(handoffUsage
          ? {
              promptTokens: handoffUsage.completionTokens,
              completionTokens: handoffUsage.completionTokens,
              totalPromptTokens: handoffUsage.totalCompletionTokens,
              totalCompletionTokens: handoffUsage.totalCompletionTokens
            }
          : {})
      })

      if (handoffFallbackTitle && firstMeaningfulMessage?.content) {
        this.scheduleThreadTitleGeneration({
          fallbackTitle: handoffFallbackTitle,
          query: buildTitleQuery(
            firstMeaningfulMessage.content,
            firstMeaningfulMessage.images,
            firstMeaningfulMessage.attachments
          ),
          runId: input.runId,
          threadId: input.thread.id
        })
      }
    } catch (error) {
      // Drain buffered deltas so cancelled/failed handoff messages include all
      // already-received output, consistent with the main run path.
      textDeltaBatcher.flush()
      reasoningDeltaBatcher.flush()

      const timestamp = this.deps.timestamp()
      const message = error instanceof Error ? error.message : String(error)
      const wasAborted = this.activeRuns.get(input.runId)?.abortController.signal.aborted ?? false

      if (wasAborted) {
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

      if (wasAborted) {
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

  /** Cancel pending memory distillation for a thread (e.g. on delete/archive). */
  cancelMemoryDistillation(threadId: string): void {
    this.memoryScheduler.cancelThread(threadId)
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
    if (thread.source && thread.source !== 'local' && !this.isOwnerDmThread(thread)) {
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
      max_token: THREAD_TITLE_MAX_TOKEN,
      signal: input.signal,
      purpose: 'thread-title'
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
    console.log(
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

    const thread = this.deps.storage.getThread(threadId)
    if (!thread) {
      return null
    }
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

    const threadMessages = this.deps.loadThreadMessages(threadId)
    const queuedMessage = threadMessages.find(
      (message) => message.id === queuedMessageId && message.role === 'user'
    )
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
