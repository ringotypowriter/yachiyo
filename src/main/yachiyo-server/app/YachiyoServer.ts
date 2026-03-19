import { randomUUID } from 'node:crypto'

import type {
  BootstrapPayload,
  ChatAccepted,
  ProviderConfig,
  ProviderSettings,
  RetryAccepted,
  RetryInput,
  SendChatInput,
  SettingsConfig,
  ThreadRecord,
  ThreadSnapshot,
  ToolPreferencesInput,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoSettingsPath } from '../config/paths.ts'
import { createAiSdkModelRuntime } from '../runtime/modelRuntime.ts'
import type { ModelRuntime } from '../runtime/types.ts'
import { createSettingsStore } from '../settings/settingsStore.ts'
import { createSqliteYachiyoStorage } from '../storage/sqlite/database.ts'
import type { YachiyoStorage } from '../storage/storage.ts'
import {
  cloneThreadWorkspace as defaultCloneThreadWorkspace,
  ensureThreadWorkspace as defaultEnsureThreadWorkspace
} from '../threads/threadWorkspace.ts'
import { YachiyoServerConfigDomain } from './domain/configDomain.ts'
import { YachiyoServerRunDomain } from './domain/runDomain.ts'
import { YachiyoServerThreadDomain } from './domain/threadDomain.ts'

export interface YachiyoServerOptions {
  storage: YachiyoStorage
  settingsPath?: string
  now?: () => Date
  createId?: () => string
  createModelRuntime?: () => ModelRuntime
  ensureThreadWorkspace?: (threadId: string) => Promise<string>
  cloneThreadWorkspace?: (sourceThreadId: string, targetThreadId: string) => Promise<string>
}

export interface SqliteYachiyoServerOptions extends Omit<YachiyoServerOptions, 'storage'> {
  dbPath: string
}

export class YachiyoServer {
  private readonly storage: YachiyoStorage
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly listeners = new Set<(event: YachiyoServerEvent) => void>()
  private readonly configDomain: YachiyoServerConfigDomain
  private readonly runDomain: YachiyoServerRunDomain
  private readonly threadDomain: YachiyoServerThreadDomain

  constructor(options: YachiyoServerOptions) {
    this.storage = options.storage
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID

    const settingsStore = createSettingsStore(options.settingsPath ?? resolveYachiyoSettingsPath())
    const createModelRuntime = options.createModelRuntime ?? (() => createAiSdkModelRuntime())
    const ensureThreadWorkspace = options.ensureThreadWorkspace ?? defaultEnsureThreadWorkspace
    const cloneThreadWorkspace = options.cloneThreadWorkspace ?? defaultCloneThreadWorkspace

    this.configDomain = new YachiyoServerConfigDomain({
      settingsStore,
      emit: this.emit.bind(this)
    })
    this.runDomain = new YachiyoServerRunDomain({
      storage: this.storage,
      createId: this.createId,
      timestamp: this.timestamp.bind(this),
      emit: this.emit.bind(this),
      createModelRuntime,
      ensureThreadWorkspace,
      readConfig: () => this.configDomain.readConfig(),
      readSettings: () => this.configDomain.readSettings(),
      requireThread: this.requireThread.bind(this),
      loadThreadMessages: (threadId) => this.storage.listThreadMessages(threadId),
      loadThreadToolCalls: (threadId) => this.storage.listThreadToolCalls(threadId)
    })
    this.threadDomain = new YachiyoServerThreadDomain({
      storage: this.storage,
      createId: this.createId,
      timestamp: this.timestamp.bind(this),
      emit: this.emit.bind(this),
      ensureThreadWorkspace,
      cloneThreadWorkspace,
      requireThread: this.requireThread.bind(this),
      isThreadRunning: (threadId) => this.runDomain.hasActiveThread(threadId)
    })
  }

  subscribe(listener: (event: YachiyoServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    await this.runDomain.close()
    this.storage.close()
  }

  recoverInterruptedRuns(error?: string): void {
    this.runDomain.recoverInterruptedRuns(error)
  }

  async bootstrap(): Promise<BootstrapPayload> {
    this.recoverInterruptedRuns()
    const recoveredQueuedFollowUps = this.runDomain.prepareRecoveredQueuedFollowUps()

    const { threads, messagesByThread, toolCallsByThread, latestRunsByThread } =
      this.storage.bootstrap()

    this.runDomain.scheduleRecoveredQueuedFollowUps(recoveredQueuedFollowUps)

    return {
      threads,
      messagesByThread,
      toolCallsByThread,
      latestRunsByThread,
      config: this.configDomain.readConfig(),
      settings: this.configDomain.readSettings()
    }
  }

  async getConfig(): Promise<SettingsConfig> {
    return this.configDomain.getConfig()
  }

  async saveConfig(input: SettingsConfig): Promise<SettingsConfig> {
    return this.configDomain.saveConfig(input)
  }

  async getSettings(): Promise<ProviderSettings> {
    return this.configDomain.getSettings()
  }

  async saveSettings(input: Partial<ProviderSettings>): Promise<ProviderSettings> {
    return this.configDomain.saveSettings(input)
  }

  async saveToolPreferences(input: ToolPreferencesInput): Promise<SettingsConfig> {
    return this.configDomain.saveToolPreferences(input)
  }

  async upsertProvider(input: ProviderConfig): Promise<ProviderConfig> {
    return this.configDomain.upsertProvider(input)
  }

  async removeProvider(input: { name: string }): Promise<SettingsConfig> {
    return this.configDomain.removeProvider(input)
  }

  async enableProviderModel(input: { name: string; model: string }): Promise<SettingsConfig> {
    return this.configDomain.enableProviderModel(input)
  }

  async disableProviderModel(input: { name: string; model: string }): Promise<SettingsConfig> {
    return this.configDomain.disableProviderModel(input)
  }

  async fetchProviderModels(input: ProviderConfig): Promise<string[]> {
    return this.configDomain.fetchProviderModels(input)
  }

  async createThread(): Promise<ThreadRecord> {
    return this.threadDomain.createThread()
  }

  async renameThread(input: { threadId: string; title: string }): Promise<ThreadRecord> {
    return this.threadDomain.renameThread(input)
  }

  async archiveThread(input: { threadId: string }): Promise<void> {
    this.threadDomain.archiveThread(input)
  }

  async sendChat(input: SendChatInput): Promise<ChatAccepted> {
    return this.runDomain.sendChat(input)
  }

  async retryMessage(input: RetryInput): Promise<RetryAccepted> {
    return this.runDomain.retryMessage(input)
  }

  async selectReplyBranch(input: {
    threadId: string
    assistantMessageId: string
  }): Promise<ThreadRecord> {
    return this.threadDomain.selectReplyBranch(input)
  }

  async createBranch(input: { threadId: string; messageId: string }): Promise<ThreadSnapshot> {
    return this.threadDomain.createBranch(input)
  }

  async deleteMessageFromHere(input: {
    threadId: string
    messageId: string
  }): Promise<ThreadSnapshot> {
    return this.threadDomain.deleteMessageFromHere(input)
  }

  async cancelRun(input: { runId: string }): Promise<void> {
    this.runDomain.cancelRun(input)
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
