import { randomUUID } from 'node:crypto'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'

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
  RunCreatedEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  SettingsConfig,
  SettingsUpdatedEvent,
  ThreadArchivedEvent,
  ThreadCreatedEvent,
  ThreadRecord,
  ThreadUpdatedEvent,
  YachiyoServerEvent,
} from '../../shared/yachiyo/protocol'
import { createYachiyoDatabase, type YachiyoDatabase } from './database.ts'
import { prepareModelMessages } from './messagePrepare.ts'
import { createAiSdkModelRuntime } from './modelRuntime.ts'
import { resolveYachiyoSettingsPath } from './paths.ts'
import { messagesTable, runsTable, threadsTable } from './schema.ts'
import { createSettingsStore, type SettingsStore, toProviderSettings } from './settingsStore.ts'
import type { ModelRuntime } from './types.ts'

const DEFAULT_THREAD_TITLE = 'New Chat'
const DEFAULT_HARNESS_NAME = 'default.reply'

interface RunState {
  threadId: string
  abortController: AbortController
}

export interface YachiyoServerOptions {
  dbPath: string
  settingsPath?: string
  now?: () => Date
  createId?: () => string
  createModelRuntime?: () => ModelRuntime
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function toThreadRecord(row: {
  id: string
  preview: string | null
  title: string
  updatedAt: string
}): ThreadRecord {
  if (row.preview === null) {
    return { id: row.id, title: row.title, updatedAt: row.updatedAt }
  }

  return {
    id: row.id,
    preview: row.preview,
    title: row.title,
    updatedAt: row.updatedAt,
  }
}

function mergeUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function upsertProvider(config: SettingsConfig, provider: ProviderConfig): SettingsConfig {
  const nextProvider = {
    ...provider,
    modelList: {
      enabled: mergeUnique(provider.modelList.enabled),
      disabled: mergeUnique(provider.modelList.disabled).filter(
        (model) => !provider.modelList.enabled.includes(model),
      ),
    },
  }
  const currentIndex = config.providers.findIndex((entry) => entry.name === provider.name)

  if (currentIndex === -1) {
    return {
      ...config,
      providers: [...config.providers, nextProvider],
    }
  }

  const providers = [...config.providers]
  providers[currentIndex] = nextProvider

  return {
    ...config,
    providers,
  }
}

function updateProviderModels(
  config: SettingsConfig,
  input: { name: string; model: string; enabled: boolean },
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
        : mergeUnique([model, ...provider.modelList.disabled]),
    },
  }

  return upsertProvider(config, nextProvider)
}

export class YachiyoServer {
  private readonly client: BetterSqlite3Database
  private readonly db: YachiyoDatabase
  private readonly settingsStore: SettingsStore
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly createModelRuntime: () => ModelRuntime
  private readonly listeners = new Set<(event: YachiyoServerEvent) => void>()
  private readonly activeRuns = new Map<string, RunState>()
  private readonly activeRunByThread = new Map<string, string>()

  constructor(options: YachiyoServerOptions) {
    const { client, db } = createYachiyoDatabase(options.dbPath)
    this.client = client
    this.db = db
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
    this.client.close()
  }

  async bootstrap(): Promise<BootstrapPayload> {
    const threads = this.db
      .select({
        id: threadsTable.id,
        preview: threadsTable.preview,
        title: threadsTable.title,
        updatedAt: threadsTable.updatedAt,
      })
      .from(threadsTable)
      .where(isNull(threadsTable.archivedAt))
      .orderBy(desc(threadsTable.updatedAt))
      .all()
      .map(toThreadRecord)

    const threadIds = threads.map((thread) => thread.id)
    const messages =
      threadIds.length === 0
        ? []
        : this.db
            .select({
              content: messagesTable.content,
              createdAt: messagesTable.createdAt,
              id: messagesTable.id,
              role: messagesTable.role,
              status: messagesTable.status,
              threadId: messagesTable.threadId,
            })
            .from(messagesTable)
            .where(inArray(messagesTable.threadId, threadIds))
            .orderBy(asc(messagesTable.createdAt))
            .all()

    const messagesByThread = Object.groupBy(messages, (message) => message.threadId) as Record<
      string,
      MessageRecord[]
    >

    return {
      threads,
      messagesByThread,
      config: this.readConfig(),
      settings: this.readSettings(),
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
          input.model?.trim() ?? currentSettings.model,
        ]),
        disabled: (existing?.modelList.disabled ?? []).filter(
          (model) => model !== (input.model?.trim() ?? currentSettings.model),
        ),
      },
    }

    const baseConfig = upsertProvider(current, nextProvider)
    const prioritizedProvider = baseConfig.providers.find((provider) => provider.name === providerName)
    const nextConfig = this.persistConfig({
      providers: prioritizedProvider
        ? [
            prioritizedProvider,
            ...baseConfig.providers.filter((provider) => provider.name !== providerName),
          ]
        : baseConfig.providers,
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
      providers,
    })
  }

  async enableProviderModel(input: { name: string; model: string }): Promise<SettingsConfig> {
    return this.persistConfig(
      updateProviderModels(this.readConfig(), {
        ...input,
        enabled: true,
      }),
    )
  }

  async disableProviderModel(input: { name: string; model: string }): Promise<SettingsConfig> {
    return this.persistConfig(
      updateProviderModels(this.readConfig(), {
        ...input,
        enabled: false,
      }),
    )
  }

  async createThread(): Promise<ThreadRecord> {
    const timestamp = this.timestamp()
    const thread: ThreadRecord = {
      id: this.createId(),
      title: DEFAULT_THREAD_TITLE,
      updatedAt: timestamp,
    }

    this.db
      .insert(threadsTable)
      .values({
        archivedAt: null,
        createdAt: timestamp,
        id: thread.id,
        preview: null,
        title: thread.title,
        updatedAt: thread.updatedAt,
      })
      .run()

    this.emit<ThreadCreatedEvent>({
      type: 'thread.created',
      threadId: thread.id,
      thread,
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
      updatedAt: this.timestamp(),
    }

    this.db
      .update(threadsTable)
      .set({
        title: updatedThread.title,
        updatedAt: updatedThread.updatedAt,
      })
      .where(eq(threadsTable.id, thread.id))
      .run()

    this.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread,
    })

    return updatedThread
  }

  async archiveThread(input: { threadId: string }): Promise<void> {
    const thread = this.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('Cannot archive a thread with an active run.')
    }
    const timestamp = this.timestamp()

    this.db
      .update(threadsTable)
      .set({
        archivedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(threadsTable.id, thread.id))
      .run()

    this.emit<ThreadArchivedEvent>({
      type: 'thread.archived',
      threadId: thread.id,
    })
  }

  async sendChat(input: { threadId: string; content: string }): Promise<ChatAccepted> {
    const content = input.content.trim()
    if (!content) {
      throw new Error('Cannot send an empty message.')
    }

    const thread = this.requireThread(input.threadId)
    if (this.activeRunByThread.has(thread.id)) {
      throw new Error('This thread already has an active run.')
    }

    const accepted = this.db.transaction((tx) => {
      const timestamp = this.timestamp()
      const userMessage: MessageRecord = {
        id: this.createId(),
        threadId: thread.id,
        role: 'user',
        content,
        status: 'completed',
        createdAt: timestamp,
      }

      tx.insert(messagesTable)
        .values(userMessage)
        .run()

      const updatedThread: ThreadRecord = {
        ...thread,
        title: thread.title === DEFAULT_THREAD_TITLE ? content.slice(0, 60) : thread.title,
        updatedAt: timestamp,
      }

      tx
        .update(threadsTable)
        .set({
          title: updatedThread.title,
          updatedAt: updatedThread.updatedAt,
        })
        .where(eq(threadsTable.id, updatedThread.id))
        .run()

      const runId = this.createId()
      tx
        .insert(runsTable)
        .values({
          completedAt: null,
          createdAt: timestamp,
          error: null,
          id: runId,
          status: 'running',
          threadId: thread.id,
        })
        .run()

      return {
        runId,
        thread: updatedThread,
        userMessage,
      }
    })

    this.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: accepted.thread.id,
      thread: accepted.thread,
    })
    this.emit<RunCreatedEvent>({
      type: 'run.created',
      threadId: accepted.thread.id,
      runId: accepted.runId,
    })

    const abortController = new AbortController()
    this.activeRuns.set(accepted.runId, { threadId: accepted.thread.id, abortController })
    this.activeRunByThread.set(accepted.thread.id, accepted.runId)
    void this.executeRun({
      runId: accepted.runId,
      thread: accepted.thread,
      abortController,
    })

    return accepted
  }

  async cancelRun(input: { runId: string }): Promise<void> {
    this.activeRuns.get(input.runId)?.abortController.abort()
  }

  private async executeRun(input: {
    runId: string
    thread: ThreadRecord
    abortController: AbortController
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
      name: DEFAULT_HARNESS_NAME,
    })
    this.emit<MessageStartedEvent>({
      type: 'message.started',
      threadId: input.thread.id,
      runId: input.runId,
      messageId,
    })

    try {
      const runtime = this.createModelRuntime()
      const messages = prepareModelMessages({
        history: this.loadThreadHistory(input.thread.id),
      })

      for await (const delta of runtime.streamReply({
        messages,
        settings,
        signal: input.abortController.signal,
      })) {
        if (!delta) continue
        buffer += delta
        this.emit<MessageDeltaEvent>({
          type: 'message.delta',
          threadId: input.thread.id,
          runId: input.runId,
          messageId,
          delta,
        })
      }

      const timestamp = this.timestamp()
      const assistantMessage: MessageRecord = {
        id: messageId,
        threadId: input.thread.id,
        role: 'assistant',
        content: buffer,
        status: 'completed',
        createdAt: timestamp,
      }

      this.db.transaction((tx) => {
        tx.insert(messagesTable)
          .values(assistantMessage)
          .run()

        tx
          .update(threadsTable)
          .set({
            preview: assistantMessage.content.slice(0, 240),
            updatedAt: timestamp,
          })
          .where(eq(threadsTable.id, input.thread.id))
          .run()

        tx
          .update(runsTable)
          .set({
            completedAt: timestamp,
            status: 'completed',
          })
          .where(eq(runsTable.id, input.runId))
          .run()
      })

      this.emit<MessageCompletedEvent>({
        type: 'message.completed',
        threadId: input.thread.id,
        runId: input.runId,
        message: assistantMessage,
      })
      this.emit<ThreadUpdatedEvent>({
        type: 'thread.updated',
        threadId: input.thread.id,
        thread: {
          ...input.thread,
          preview: assistantMessage.content.slice(0, 240),
          updatedAt: timestamp,
        },
      })
      this.emit<HarnessFinishedEvent>({
        type: 'harness.finished',
        threadId: input.thread.id,
        runId: input.runId,
        harnessId,
        name: DEFAULT_HARNESS_NAME,
        status: 'completed',
      })
      this.emit<RunCompletedEvent>({
        type: 'run.completed',
        threadId: input.thread.id,
        runId: input.runId,
      })
    } catch (error) {
      if (input.abortController.signal.aborted || isAbortError(error)) {
        const timestamp = this.timestamp()
        this.db
          .update(runsTable)
          .set({
            completedAt: timestamp,
            status: 'cancelled',
          })
          .where(eq(runsTable.id, input.runId))
          .run()

        this.emit<HarnessFinishedEvent>({
          type: 'harness.finished',
          threadId: input.thread.id,
          runId: input.runId,
          harnessId,
          name: DEFAULT_HARNESS_NAME,
          status: 'cancelled',
        })
        this.emit<RunCancelledEvent>({
          type: 'run.cancelled',
          threadId: input.thread.id,
          runId: input.runId,
        })
      } else {
        const message = error instanceof Error ? error.message : 'Unknown model runtime error'
        const timestamp = this.timestamp()
        this.db
          .update(runsTable)
          .set({
            completedAt: timestamp,
            error: message,
            status: 'failed',
          })
          .where(eq(runsTable.id, input.runId))
          .run()

        this.emit<HarnessFinishedEvent>({
          type: 'harness.finished',
          threadId: input.thread.id,
          runId: input.runId,
          harnessId,
          name: DEFAULT_HARNESS_NAME,
          status: 'failed',
          error: message,
        })
        this.emit<RunFailedEvent>({
          type: 'run.failed',
          threadId: input.thread.id,
          runId: input.runId,
          error: message,
        })
      }
    } finally {
      this.activeRuns.delete(input.runId)
      this.activeRunByThread.delete(input.thread.id)
    }
  }

  private loadThreadHistory(threadId: string) {
    return this.db
      .select({
        content: messagesTable.content,
        role: messagesTable.role,
      })
      .from(messagesTable)
      .where(eq(messagesTable.threadId, threadId))
      .orderBy(asc(messagesTable.createdAt))
      .all()
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
      settings: toProviderSettings(config),
    })
    return config
  }

  private requireThread(threadId: string): ThreadRecord {
    const thread = this.db
      .select({
        id: threadsTable.id,
        preview: threadsTable.preview,
        title: threadsTable.title,
        updatedAt: threadsTable.updatedAt,
      })
      .from(threadsTable)
      .where(and(eq(threadsTable.id, threadId), isNull(threadsTable.archivedAt)))
      .get()

    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`)
    }

    return toThreadRecord(thread)
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private emit<TEvent extends YachiyoServerEvent>(
    event: Omit<TEvent, 'eventId' | 'timestamp'>,
  ): void {
    const completeEvent = {
      eventId: this.createId(),
      timestamp: this.timestamp(),
      ...event,
    } as TEvent

    for (const listener of this.listeners) {
      listener(completeEvent)
    }
  }
}
