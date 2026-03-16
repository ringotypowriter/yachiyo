import { randomUUID } from 'node:crypto'

import type {
  BootstrapPayload,
  ChatAccepted,
  HarnessFinishedEvent,
  HarnessStartedEvent,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageRecord,
  MessageStartedEvent,
  ProviderConfig,
  ProviderSettings,
  RetryAccepted,
  RunCreatedEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  SettingsConfig,
  SettingsUpdatedEvent,
  ThreadArchivedEvent,
  ThreadCreatedEvent,
  MessageImageRecord,
  ThreadRecord,
  ThreadSnapshot,
  ThreadStateReplacedEvent,
  ThreadUpdatedEvent,
  YachiyoServerEvent
} from '../../shared/yachiyo/protocol'
import {
  extractBase64DataUrlPayload,
  hasMessagePayload,
  normalizeMessageImages,
  summarizeMessageInput
} from '../../shared/yachiyo/messageContent.ts'
import {
  collectDescendantIds,
  collectMessagePath,
  pickLatestLeafId,
  pickReplacementHeadId,
  sortMessagesByCreatedAt
} from '../../shared/yachiyo/threadTree.ts'
import { createSqliteYachiyoStorage } from './database.ts'
import { prepareModelMessages } from './messagePrepare.ts'
import { createAiSdkModelRuntime, fetchModels } from './modelRuntime.ts'
import { resolveYachiyoSettingsPath } from './paths.ts'
import { createSettingsStore, type SettingsStore, toProviderSettings } from './settingsStore.ts'
import type { YachiyoStorage } from './storage.ts'
import type { ModelRuntime } from './types.ts'

const DEFAULT_THREAD_TITLE = 'New Chat'
const DEFAULT_HARNESS_NAME = 'default.reply'

interface RunState {
  threadId: string
  requestMessageId: string
  abortController: AbortController
  updateHeadOnComplete: boolean
}

export interface YachiyoServerOptions {
  storage: YachiyoStorage
  settingsPath?: string
  now?: () => Date
  createId?: () => string
  createModelRuntime?: () => ModelRuntime
}

export interface SqliteYachiyoServerOptions extends Omit<YachiyoServerOptions, 'storage'> {
  dbPath: string
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function mergeUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function assertSupportedImages(images: MessageImageRecord[]): void {
  for (const image of images) {
    if (!image.mediaType.startsWith('image/')) {
      throw new Error('Only image inputs are supported right now.')
    }

    const parsedImage = extractBase64DataUrlPayload(image.dataUrl)
    if (!parsedImage || !parsedImage.mediaType.startsWith('image/')) {
      throw new Error('Image input is not ready to send yet.')
    }
  }
}

function upsertProvider(config: SettingsConfig, provider: ProviderConfig): SettingsConfig {
  const nextProvider = {
    ...provider,
    modelList: {
      enabled: mergeUnique(provider.modelList.enabled),
      disabled: mergeUnique(provider.modelList.disabled).filter(
        (model) => !provider.modelList.enabled.includes(model)
      )
    }
  }
  const currentIndex = config.providers.findIndex((entry) => entry.name === provider.name)

  if (currentIndex === -1) {
    return {
      ...config,
      providers: [...config.providers, nextProvider]
    }
  }

  const providers = [...config.providers]
  providers[currentIndex] = nextProvider

  return {
    ...config,
    providers
  }
}

function updateProviderModels(
  config: SettingsConfig,
  input: { name: string; model: string; enabled: boolean }
): SettingsConfig {
  const name = input.name.trim()
  const model = input.model.trim()
  const provider = config.providers.find((entry) => entry.name === name)

  if (!provider) {
    throw new Error(`Unknown provider: ${name}`)
  }

  const nextProvider: ProviderConfig = {
    ...provider,
    modelList: {
      enabled: input.enabled
        ? mergeUnique([...provider.modelList.enabled, model])
        : provider.modelList.enabled.filter((entry) => entry !== model),
      disabled: input.enabled
        ? provider.modelList.disabled.filter((entry) => entry !== model)
        : mergeUnique([model, ...provider.modelList.disabled])
    }
  }

  return upsertProvider(config, nextProvider)
}

export class YachiyoServer {
  private readonly storage: YachiyoStorage
  private readonly settingsStore: SettingsStore
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly createModelRuntime: () => ModelRuntime
  private readonly listeners = new Set<(event: YachiyoServerEvent) => void>()
  private readonly activeRuns = new Map<string, RunState>()
  private readonly activeRunByThread = new Map<string, string>()

  constructor(options: YachiyoServerOptions) {
    this.storage = options.storage
    this.settingsStore = createSettingsStore(options.settingsPath ?? resolveYachiyoSettingsPath())
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    this.createModelRuntime = options.createModelRuntime ?? (() => createAiSdkModelRuntime())
  }

  subscribe(listener: (event: YachiyoServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    for (const state of this.activeRuns.values()) {
      state.abortController.abort()
    }
    this.activeRuns.clear()
    this.activeRunByThread.clear()
    this.storage.close()
  }

  async bootstrap(): Promise<BootstrapPayload> {
    const { threads, messagesByThread } = this.storage.bootstrap()

    return {
      threads,
      messagesByThread,
      config: this.readConfig(),
      settings: this.readSettings()
    }
  }

  async getConfig(): Promise<SettingsConfig> {
    return this.readConfig()
  }

  async saveConfig(input: SettingsConfig): Promise<SettingsConfig> {
    return this.persistConfig(input)
  }

  async getSettings(): Promise<ProviderSettings> {
    return this.readSettings()
  }

  async saveSettings(input: Partial<ProviderSettings>): Promise<ProviderSettings> {
    const current = this.readConfig()
    const currentSettings = this.readSettings()
    const providerName =
      input.providerName?.trim() ||
      currentSettings.providerName ||
      input.provider?.trim() ||
      'provider'

    const existing =
      current.providers.find((provider) => provider.name === providerName) ??
      current.providers.find((provider) => provider.type === input.provider)

    const nextProvider: ProviderConfig = {
      name: providerName,
      type: input.provider ?? existing?.type ?? currentSettings.provider,
      apiKey: input.apiKey?.trim() ?? existing?.apiKey ?? currentSettings.apiKey,
      baseUrl: input.baseUrl?.trim() ?? existing?.baseUrl ?? currentSettings.baseUrl,
      modelList: {
        enabled: mergeUnique([
          ...(existing?.modelList.enabled ?? []),
          input.model?.trim() ?? currentSettings.model
        ]),
        disabled: (existing?.modelList.disabled ?? []).filter(
          (model) => model !== (input.model?.trim() ?? currentSettings.model)
        )
      }
    }

    const baseConfig = upsertProvider(current, nextProvider)
    const prioritizedProvider = baseConfig.providers.find(
      (provider) => provider.name === providerName
    )
    const nextConfig = this.persistConfig({
      providers: prioritizedProvider
        ? [
            prioritizedProvider,
            ...baseConfig.providers.filter((provider) => provider.name !== providerName)
          ]
        : baseConfig.providers
    })

    return toProviderSettings(nextConfig)
  }

  async upsertProvider(input: ProviderConfig): Promise<ProviderConfig> {
    const nextConfig = this.persistConfig(upsertProvider(this.readConfig(), input))
    const provider = nextConfig.providers.find((entry) => entry.name === input.name)
    if (!provider) {
      throw new Error(`Unknown provider: ${input.name}`)
    }
    return provider
  }

  async removeProvider(input: { name: string }): Promise<SettingsConfig> {
    const name = input.name.trim()
    const current = this.readConfig()
    const providers = current.providers.filter((provider) => provider.name !== name)

    if (providers.length === current.providers.length) {
      throw new Error(`Unknown provider: ${name}`)
    }

    return this.persistConfig({
      ...current,
      providers
    })
  }

  async enableProviderModel(input: { name: string; model: string }): Promise<SettingsConfig> {
    return this.persistConfig(
      updateProviderModels(this.readConfig(), {
        ...input,
        enabled: true
      })
    )
  }

  async disableProviderModel(input: { name: string; model: string }): Promise<SettingsConfig> {
    return this.persistConfig(
      updateProviderModels(this.readConfig(), {
        ...input,
        enabled: false
      })
    )
  }

  async fetchProviderModels(input: ProviderConfig): Promise<string[]> {
    console.log('[fetchProviderModels] called with:', {
      name: input.name,
      type: input.type,
      baseUrl: input.baseUrl || '(default)',
      hasApiKey: Boolean(input.apiKey?.trim())
    })
    const models = await fetchModels(input)
    console.log('[fetchProviderModels] result:', models.length, 'models', models.slice(0, 5))
    return models
  }

  async createThread(): Promise<ThreadRecord> {
    const timestamp = this.timestamp()
    const thread: ThreadRecord = {
      id: this.createId(),
      title: DEFAULT_THREAD_TITLE,
      updatedAt: timestamp
    }

    this.storage.createThread({ thread, createdAt: timestamp })

    this.emit<ThreadCreatedEvent>({
      type: 'thread.created',
      threadId: thread.id,
      thread
    })

    return thread
  }

  async renameThread(input: { threadId: string; title: string }): Promise<ThreadRecord> {
    const title = input.title.trim()
    if (!title) {
      throw new Error('Thread title cannot be empty.')
    }

    const thread = this.requireThread(input.threadId)
    const updatedThread: ThreadRecord = {
      ...thread,
      title,
      updatedAt: this.timestamp()
    }

    this.storage.renameThread({
      threadId: thread.id,
      title: updatedThread.title,
      updatedAt: updatedThread.updatedAt
    })

    this.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    return updatedThread
  }

  async archiveThread(input: { threadId: string }): Promise<void> {
    const thread = this.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('Cannot archive a thread with an active run.')
    }
    const timestamp = this.timestamp()

    this.storage.archiveThread({
      threadId: thread.id,
      archivedAt: timestamp,
      updatedAt: timestamp
    })

    this.emit<ThreadArchivedEvent>({
      type: 'thread.archived',
      threadId: thread.id
    })
  }

  async sendChat(input: {
    threadId: string
    content: string
    images?: MessageImageRecord[]
  }): Promise<ChatAccepted> {
    const content = input.content.trim()
    const images = normalizeMessageImages(input.images)

    if (!hasMessagePayload({ content, images })) {
      throw new Error('Cannot send an empty message.')
    }
    assertSupportedImages(images)

    const thread = this.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('This thread already has an active run.')
    }

    const timestamp = this.timestamp()
    const messageSummary = summarizeMessageInput({ content, images })
    const userMessage: MessageRecord = {
      id: this.createId(),
      threadId: thread.id,
      ...(thread.headMessageId ? { parentMessageId: thread.headMessageId } : {}),
      role: 'user',
      content,
      ...(images.length > 0 ? { images } : {}),
      status: 'completed',
      createdAt: timestamp
    }
    const updatedThread: ThreadRecord = {
      ...thread,
      headMessageId: userMessage.id,
      ...(messageSummary ? { preview: messageSummary.slice(0, 240) } : {}),
      title:
        thread.title === DEFAULT_THREAD_TITLE
          ? (messageSummary || DEFAULT_THREAD_TITLE).slice(0, 60)
          : thread.title,
      updatedAt: timestamp
    }
    const accepted = {
      runId: this.createId(),
      thread: updatedThread,
      userMessage
    }

    this.storage.startRun({
      runId: accepted.runId,
      requestMessageId: userMessage.id,
      thread,
      updatedThread,
      userMessage,
      createdAt: timestamp
    })

    this.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: accepted.thread.id,
      thread: accepted.thread
    })
    this.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: accepted.thread.id,
      runId: accepted.runId,
      requestMessageId: userMessage.id
    })

    this.startActiveRun({
      runId: accepted.runId,
      thread: accepted.thread,
      requestMessageId: userMessage.id,
      updateHeadOnComplete: true
    })

    return accepted
  }

  async retryMessage(input: {
    threadId: string
    messageId: string
  }): Promise<RetryAccepted> {
    const thread = this.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('This thread already has an active run.')
    }

    const { requestMessage, sourceAssistantMessage } = this.resolveRetryRequest(thread, input.messageId)
    const timestamp = this.timestamp()
    const updatedThread: ThreadRecord = {
      ...thread,
      updatedAt: timestamp
    }
    const accepted: RetryAccepted = {
      runId: this.createId(),
      thread: updatedThread,
      requestMessageId: requestMessage.id,
      ...(sourceAssistantMessage ? { sourceAssistantMessageId: sourceAssistantMessage.id } : {})
    }

    this.storage.startRun({
      runId: accepted.runId,
      requestMessageId: requestMessage.id,
      thread,
      updatedThread,
      createdAt: timestamp
    })

    this.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: accepted.thread.id,
      thread: accepted.thread
    })
    this.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: accepted.thread.id,
      runId: accepted.runId,
      requestMessageId: requestMessage.id
    })

    this.startActiveRun({
      runId: accepted.runId,
      thread: accepted.thread,
      requestMessageId: requestMessage.id,
      updateHeadOnComplete: true
    })

    return accepted
  }

  async selectReplyBranch(input: {
    threadId: string
    assistantMessageId: string
  }): Promise<ThreadRecord> {
    const thread = this.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('Cannot switch reply branches while this thread is running.')
    }

    const { sourceAssistantMessage } = this.resolveRetryRequest(thread, input.assistantMessageId)
    if (!sourceAssistantMessage) {
      throw new Error('This message cannot be used as a reply branch.')
    }
    const messages = this.loadThreadMessages(thread.id)
    const nextHeadMessageId =
      pickLatestLeafId(messages, sourceAssistantMessage.id) ?? sourceAssistantMessage.id
    const previewSource = messages.find((message) => message.id === nextHeadMessageId)
    const preview = previewSource ? summarizeMessageInput(previewSource) : ''
    const timestamp = this.timestamp()
    const updatedThread: ThreadRecord = {
      ...thread,
      updatedAt: timestamp,
      headMessageId: nextHeadMessageId,
      ...(preview ? { preview: preview.slice(0, 240) } : {})
    }

    if (!preview) {
      delete updatedThread.preview
    }

    this.storage.updateThread(updatedThread)
    this.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    return updatedThread
  }

  async createBranch(input: { threadId: string; messageId: string }): Promise<ThreadSnapshot> {
    const thread = this.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('Cannot branch a thread with an active run.')
    }

    const messages = this.loadThreadMessages(thread.id)
    const branchPoint = messages.find((message) => message.id === input.messageId)

    if (!branchPoint) {
      throw new Error(`Unknown message: ${input.messageId}`)
    }

    const path = collectMessagePath(messages, branchPoint.id)
    const timestamp = this.timestamp()
    const threadId = this.createId()
    const idMap = new Map<string, string>()
    const clonedMessages = path.map((message) => {
      const clonedId = this.createId()
      idMap.set(message.id, clonedId)

      return {
        ...message,
        id: clonedId,
        threadId,
        ...(message.parentMessageId ? { parentMessageId: idMap.get(message.parentMessageId)! } : {})
      }
    })
    const previewSource = clonedMessages.at(-1)
    const preview = previewSource ? summarizeMessageInput(previewSource) : ''
    const branchThread: ThreadRecord = {
      id: threadId,
      title: this.deriveBranchTitle(thread, branchPoint),
      updatedAt: timestamp,
      branchFromThreadId: thread.id,
      branchFromMessageId: branchPoint.id,
      ...(preview ? { preview: preview.slice(0, 240) } : {}),
      ...(previewSource ? { headMessageId: previewSource.id } : {})
    }

    this.storage.createThread({
      thread: branchThread,
      createdAt: timestamp,
      messages: clonedMessages
    })

    this.emit<ThreadCreatedEvent>({
      type: 'thread.created',
      threadId: branchThread.id,
      thread: branchThread
    })
    this.emit<ThreadStateReplacedEvent>({
      type: 'thread.state.replaced',
      threadId: branchThread.id,
      thread: branchThread,
      messages: clonedMessages
    })

    return {
      thread: branchThread,
      messages: clonedMessages
    }
  }

  async deleteMessageFromHere(input: {
    threadId: string
    messageId: string
  }): Promise<ThreadSnapshot> {
    const thread = this.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('Cannot edit history while this thread is running.')
    }

    const messages = this.loadThreadMessages(thread.id)
    const targetMessage = messages.find((message) => message.id === input.messageId)

    if (!targetMessage) {
      throw new Error(`Unknown message: ${input.messageId}`)
    }

    const deletedIds = collectDescendantIds(messages, targetMessage.id)
    const remainingMessages = sortMessagesByCreatedAt(
      messages.filter((message) => !deletedIds.has(message.id))
    )
    const timestamp = this.timestamp()
    const nextHeadMessageId = pickReplacementHeadId(messages, remainingMessages, thread.headMessageId)
    const previewSource = nextHeadMessageId
      ? remainingMessages.find((message) => message.id === nextHeadMessageId)
      : undefined
    const preview = previewSource ? summarizeMessageInput(previewSource) : ''
    const updatedThread: ThreadRecord = {
      ...thread,
      title: remainingMessages.length === 0 ? DEFAULT_THREAD_TITLE : thread.title,
      updatedAt: timestamp,
      ...(nextHeadMessageId ? { headMessageId: nextHeadMessageId } : {}),
      ...(preview ? { preview: preview.slice(0, 240) } : {})
    }

    if (!nextHeadMessageId) {
      delete updatedThread.headMessageId
    }

    if (!preview) {
      delete updatedThread.preview
    }

    this.storage.deleteMessages({
      thread: updatedThread,
      messageIds: [...deletedIds]
    })

    this.emit<ThreadStateReplacedEvent>({
      type: 'thread.state.replaced',
      threadId: updatedThread.id,
      thread: updatedThread,
      messages: remainingMessages
    })

    return {
      thread: updatedThread,
      messages: remainingMessages
    }
  }

  async cancelRun(input: { runId: string }): Promise<void> {
    this.activeRuns.get(input.runId)?.abortController.abort()
  }

  private startActiveRun(input: {
    runId: string
    thread: ThreadRecord
    requestMessageId: string
    updateHeadOnComplete: boolean
  }): void {
    const abortController = new AbortController()
    this.activeRuns.set(input.runId, {
      threadId: input.thread.id,
      requestMessageId: input.requestMessageId,
      abortController,
      updateHeadOnComplete: input.updateHeadOnComplete
    })
    this.activeRunByThread.set(input.thread.id, input.runId)
    void this.executeRun({
      abortController,
      requestMessageId: input.requestMessageId,
      runId: input.runId,
      thread: input.thread,
      updateHeadOnComplete: input.updateHeadOnComplete
    })
  }

  private async executeRun(input: {
    runId: string
    thread: ThreadRecord
    requestMessageId: string
    abortController: AbortController
    updateHeadOnComplete: boolean
  }): Promise<void> {
    const settings = this.readSettings()
    const harnessId = this.createId()
    const messageId = this.createId()
    let buffer = ''

    this.emit<HarnessStartedEvent>({
      type: 'harness.started',
      threadId: input.thread.id,
      runId: input.runId,
      harnessId,
      name: DEFAULT_HARNESS_NAME
    })
    this.emit<MessageStartedEvent>({
      type: 'message.started',
      threadId: input.thread.id,
      runId: input.runId,
      messageId,
      parentMessageId: input.requestMessageId
    })

    try {
      const runtime = this.createModelRuntime()
      const messages = prepareModelMessages({
        history: this.loadRunHistory(input.thread.id, input.requestMessageId)
      })

      for await (const delta of runtime.streamReply({
        messages,
        settings,
        signal: input.abortController.signal
      })) {
        if (!delta) continue
        buffer += delta
        this.emit<MessageDeltaEvent>({
          type: 'message.delta',
          threadId: input.thread.id,
          runId: input.runId,
          messageId,
          delta
        })
      }

      const timestamp = this.timestamp()
      const assistantMessage: MessageRecord = {
        id: messageId,
        threadId: input.thread.id,
        parentMessageId: input.requestMessageId,
        role: 'assistant',
        content: buffer,
        status: 'completed',
        createdAt: timestamp,
        modelId: settings.model,
        providerName: settings.providerName
      }

      const updatedThread: ThreadRecord = {
        ...input.thread,
        updatedAt: timestamp,
        ...(input.updateHeadOnComplete
          ? { preview: assistantMessage.content.slice(0, 240) }
          : input.thread.preview
            ? { preview: input.thread.preview }
            : {}),
        ...(input.updateHeadOnComplete
          ? { headMessageId: assistantMessage.id }
          : input.thread.headMessageId
            ? { headMessageId: input.thread.headMessageId }
            : {})
      }

      this.storage.completeRun({ runId: input.runId, updatedThread, assistantMessage })

      this.emit<MessageCompletedEvent>({
        type: 'message.completed',
        threadId: input.thread.id,
        runId: input.runId,
        message: assistantMessage
      })
      this.emit<ThreadUpdatedEvent>({
        type: 'thread.updated',
        threadId: input.thread.id,
        thread: updatedThread
      })
      this.emit<HarnessFinishedEvent>({
        type: 'harness.finished',
        threadId: input.thread.id,
        runId: input.runId,
        harnessId,
        name: DEFAULT_HARNESS_NAME,
        status: 'completed'
      })
      this.emit<RunCompletedEvent>({
        type: 'run.completed',
        threadId: input.thread.id,
        runId: input.runId
      })
    } catch (error) {
      if (input.abortController.signal.aborted || isAbortError(error)) {
        const timestamp = this.timestamp()
        this.storage.cancelRun({
          runId: input.runId,
          completedAt: timestamp
        })

        this.emit<HarnessFinishedEvent>({
          type: 'harness.finished',
          threadId: input.thread.id,
          runId: input.runId,
          harnessId,
          name: DEFAULT_HARNESS_NAME,
          status: 'cancelled'
        })
        this.emit<RunCancelledEvent>({
          type: 'run.cancelled',
          threadId: input.thread.id,
          runId: input.runId
        })
      } else {
        const message = error instanceof Error ? error.message : 'Unknown model runtime error'
        const timestamp = this.timestamp()
        this.storage.failRun({
          runId: input.runId,
          completedAt: timestamp,
          error: message
        })

        this.emit<HarnessFinishedEvent>({
          type: 'harness.finished',
          threadId: input.thread.id,
          runId: input.runId,
          harnessId,
          name: DEFAULT_HARNESS_NAME,
          status: 'failed',
          error: message
        })
        this.emit<RunFailedEvent>({
          type: 'run.failed',
          threadId: input.thread.id,
          runId: input.runId,
          error: message
        })
      }
    } finally {
      this.activeRuns.delete(input.runId)
      this.activeRunByThread.delete(input.thread.id)
    }
  }

  private loadThreadMessages(threadId: string): MessageRecord[] {
    return this.storage.listThreadMessages(threadId)
  }

  private loadRunHistory(
    threadId: string,
    requestMessageId: string
  ): Array<Pick<MessageRecord, 'content' | 'images' | 'role'>> {
    return collectMessagePath(this.loadThreadMessages(threadId), requestMessageId).map(
      ({ content, images, role }) => ({
        content,
        ...(images ? { images } : {}),
        role
      })
    )
  }

  private resolveRetryRequest(
    thread: ThreadRecord,
    messageId: string
  ): { requestMessage: MessageRecord; sourceAssistantMessage?: MessageRecord } {
    const messages = this.loadThreadMessages(thread.id)
    const target = messages.find((message) => message.id === messageId)

    if (!target) {
      throw new Error(`Unknown message: ${messageId}`)
    }

    if (target.role === 'user') {
      const sourceAssistantMessage = this.resolveActiveAssistantForRequest(thread, messages, target.id)

      return {
        requestMessage: target,
        ...(sourceAssistantMessage ? { sourceAssistantMessage } : {})
      }
    }

    if (!target.parentMessageId) {
      throw new Error('This message cannot be retried.')
    }

    const requestMessage = messages.find((message) => message.id === target.parentMessageId)
    if (!requestMessage || requestMessage.role !== 'user') {
      throw new Error('This message cannot be retried.')
    }

    return {
      requestMessage,
      sourceAssistantMessage: target
    }
  }

  private resolveActiveAssistantForRequest(
    thread: ThreadRecord,
    messages: MessageRecord[],
    requestMessageId: string
  ): MessageRecord | undefined {
    const activePath =
      thread.headMessageId && messages.some((message) => message.id === thread.headMessageId)
        ? collectMessagePath(messages, thread.headMessageId)
        : []
    const requestIndex = activePath.findIndex((message) => message.id === requestMessageId)
    const pathAssistant = requestIndex >= 0 ? activePath[requestIndex + 1] : undefined

    if (
      pathAssistant?.role === 'assistant' &&
      pathAssistant.parentMessageId === requestMessageId
    ) {
      return pathAssistant
    }

    return messages
      .filter(
        (message): message is MessageRecord =>
          message.role === 'assistant' && message.parentMessageId === requestMessageId
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1)
  }

  private deriveBranchTitle(thread: ThreadRecord, branchPoint: MessageRecord): string {
    if (thread.title !== DEFAULT_THREAD_TITLE) {
      return thread.title
    }

    const titleSource = summarizeMessageInput(branchPoint)
    return titleSource ? titleSource.slice(0, 60) : DEFAULT_THREAD_TITLE
  }

  private readSettings(): ProviderSettings {
    return toProviderSettings(this.readConfig())
  }

  private readConfig(): SettingsConfig {
    return this.settingsStore.read()
  }

  private persistConfig(input: SettingsConfig): SettingsConfig {
    this.settingsStore.write(input)
    const config = this.readConfig()
    this.emit<SettingsUpdatedEvent>({
      type: 'settings.updated',
      config,
      settings: toProviderSettings(config)
    })
    return config
  }

  private requireThread(threadId: string): ThreadRecord {
    const thread = this.storage.getThread(threadId)

    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`)
    }

    return thread
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private emit<TEvent extends YachiyoServerEvent>(
    event: Omit<TEvent, 'eventId' | 'timestamp'>
  ): void {
    const completeEvent = {
      eventId: this.createId(),
      timestamp: this.timestamp(),
      ...event
    } as TEvent

    for (const listener of this.listeners) {
      listener(completeEvent)
    }
  }
}

export function createSqliteYachiyoServer(options: SqliteYachiyoServerOptions): YachiyoServer {
  return new YachiyoServer({
    ...options,
    storage: createSqliteYachiyoStorage(options.dbPath)
  })
}
