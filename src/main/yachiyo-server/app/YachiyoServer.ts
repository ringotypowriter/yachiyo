import { randomUUID } from 'node:crypto'

import type {
  BootstrapPayload,
  ChatAccepted,
  ImportWebSearchBrowserSessionInput,
  ProviderConfig,
  ProviderSettings,
  RetryAccepted,
  RetryInput,
  SendChatInput,
  SettingsConfig,
  ThreadRecord,
  ThreadSnapshot,
  ToolPreferencesInput,
  WebSearchBrowserImportSource,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import {
  resolveYachiyoSettingsPath,
  resolveYachiyoWebSearchBrowserSessionPath
} from '../config/paths.ts'
import { createAuxiliaryGenerationService } from '../runtime/auxiliaryGeneration.ts'
import { createAiSdkModelRuntime } from '../runtime/modelRuntime.ts'
import type { ModelRuntime } from '../runtime/types.ts'
import {
  BrowserSearchSession,
  createBrowserSearchSessionImportService,
  resolveGoogleChromeDataPath
} from '../services/webSearch/browserSearchSession.ts'
import {
  createElectronBrowserSearchPageFactory,
  type BrowserSearchDiagnosticEvent
} from '../services/webSearch/electronBrowserSearchSession.ts'
import { createGoogleBrowserWebSearchProvider } from '../services/webSearch/providers/googleBrowserWebSearchProvider.ts'
import { createWebSearchService } from '../services/webSearch/webSearchService.ts'
import { createSettingsStore } from '../settings/settingsStore.ts'
import { createSqliteYachiyoStorage } from '../storage/sqlite/database.ts'
import type { YachiyoStorage } from '../storage/storage.ts'
import {
  cloneThreadWorkspace as defaultCloneThreadWorkspace,
  deleteThreadWorkspace as defaultDeleteThreadWorkspace,
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
  deleteThreadWorkspace?: (threadId: string) => Promise<void>
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
  private readonly browserSearchSession: BrowserSearchSession

  private static logBrowserSearchDiagnostic(event: BrowserSearchDiagnosticEvent): void {
    const details = {
      profilePath: event.profilePath,
      ...(event.url ? { url: event.url } : {}),
      ...(event.code !== undefined ? { code: String(event.code) } : {}),
      ...(event.details ?? {})
    }
    const suffix = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ')

    console.warn(`[web-search] ${event.event}${suffix ? ` ${suffix}` : ''}`)
  }

  constructor(options: YachiyoServerOptions) {
    this.storage = options.storage
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID

    const settingsStore = createSettingsStore(options.settingsPath ?? resolveYachiyoSettingsPath())
    const createModelRuntime = options.createModelRuntime ?? (() => createAiSdkModelRuntime())
    const ensureThreadWorkspace = options.ensureThreadWorkspace ?? defaultEnsureThreadWorkspace
    const cloneThreadWorkspace = options.cloneThreadWorkspace ?? defaultCloneThreadWorkspace
    const deleteThreadWorkspace = options.deleteThreadWorkspace ?? defaultDeleteThreadWorkspace
    this.browserSearchSession = new BrowserSearchSession({
      pageFactory: createElectronBrowserSearchPageFactory({
        log: YachiyoServer.logBrowserSearchDiagnostic
      }),
      profilePath: resolveYachiyoWebSearchBrowserSessionPath()
    })
    const webSearchImportService = createBrowserSearchSessionImportService({
      chromeDataPath: resolveGoogleChromeDataPath()
    })
    const webSearchService = createWebSearchService({
      providers: [
        createGoogleBrowserWebSearchProvider({
          browserSession: this.browserSearchSession
        })
      ],
      readConfig: () => this.configDomain.readConfig()
    })

    this.configDomain = new YachiyoServerConfigDomain({
      settingsStore,
      emit: this.emit.bind(this),
      webSearchDeps: {
        listBrowserImportSources: () => webSearchImportService.listSources(),
        importBrowserSession: (input) =>
          this.browserSearchSession.withExclusiveAccess(async () =>
            webSearchImportService.importSession({
              profilePath: this.browserSearchSession.profilePath,
              sourceBrowser: input.sourceBrowser,
              sourceProfileName: input.sourceProfileName
            })
          )
      }
    })
    const auxiliaryGeneration = createAuxiliaryGenerationService({
      createModelRuntime,
      readToolModelSettings: () => this.configDomain.readToolModelSettings()
    })
    this.runDomain = new YachiyoServerRunDomain({
      storage: this.storage,
      createId: this.createId,
      timestamp: this.timestamp.bind(this),
      emit: this.emit.bind(this),
      auxiliaryGeneration,
      createModelRuntime,
      ensureThreadWorkspace,
      webSearchService,
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
      deleteThreadWorkspace,
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

    const { archivedThreads, threads, messagesByThread, toolCallsByThread, latestRunsByThread } =
      this.storage.bootstrap()

    this.runDomain.scheduleRecoveredQueuedFollowUps(recoveredQueuedFollowUps)

    return {
      threads,
      archivedThreads,
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

  async listWebSearchBrowserImportSources(): Promise<WebSearchBrowserImportSource[]> {
    return this.configDomain.listWebSearchBrowserImportSources()
  }

  async importWebSearchBrowserSession(
    input: ImportWebSearchBrowserSessionInput
  ): Promise<SettingsConfig> {
    return this.configDomain.importWebSearchBrowserSession(input)
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

  async restoreThread(input: { threadId: string }): Promise<ThreadRecord> {
    return this.threadDomain.restoreThread(input)
  }

  async deleteThread(input: { threadId: string }): Promise<void> {
    await this.threadDomain.deleteThread(input)
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
