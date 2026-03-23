import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  BootstrapPayload,
  ChatAccepted,
  CompactThreadAccepted,
  CompactThreadInput,
  FileMentionCandidate,
  ImportWebSearchBrowserSessionInput,
  ListSkillsInput,
  ProviderConfig,
  ProviderSettings,
  RetryAccepted,
  RetryInput,
  SaveThreadInput,
  SaveThreadResult,
  SearchWorkspaceFilesInput,
  SendChatInput,
  SettingsConfig,
  SkillCatalogEntry,
  TestMemoryConnectionResult,
  ThreadRecord,
  ThreadSearchResult,
  ThreadSnapshot,
  ToolPreferencesInput,
  UserDocument,
  WebSearchBrowserImportSource,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import {
  resolveYachiyoSettingsPath,
  resolveYachiyoWebSearchBrowserSessionPath
} from '../config/paths.ts'
import { createAuxiliaryGenerationService } from '../runtime/auxiliaryGeneration.ts'
import { searchWorkspaceFileMentionCandidates } from '../runtime/fileMentions.ts'
import { createAiSdkModelRuntime } from '../runtime/modelRuntime.ts'
import { readSoulDocument, type SoulDocument } from '../runtime/soul.ts'
import { readUserDocument, writeUserDocument } from '../runtime/user.ts'
import type { ModelRuntime } from '../runtime/types.ts'
import { createSearchService, type SearchService } from '../services/search/searchService.ts'
import { createMemoryService, type MemoryService } from '../services/memory/memoryService.ts'
import { createNowledgeMemProvider } from '../services/memory/nowledgeMemProvider.ts'
import { discoverSkills } from '../services/skills/skillDiscovery.ts'
import { buildSkillRegistry } from '../services/skills/skillRegistry.ts'
import { createBrowserWebPageSnapshotLoader } from '../services/webRead/browserWebPageSnapshot.ts'
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
  fetchImpl?: typeof globalThis.fetch
  now?: () => Date
  createId?: () => string
  createModelRuntime?: () => ModelRuntime
  searchService?: SearchService
  readSoulDocument?: () => Promise<SoulDocument | null>
  readUserDocument?: () => Promise<UserDocument | null>
  saveUserDocument?: (content: string) => Promise<UserDocument | null>
  ensureThreadWorkspace?: (threadId: string) => Promise<string>
  cloneThreadWorkspace?: (sourceThreadId: string, targetThreadId: string) => Promise<string>
  deleteThreadWorkspace?: (threadId: string) => Promise<void>
  memoryService?: MemoryService
}

export interface SqliteYachiyoServerOptions extends Omit<YachiyoServerOptions, 'storage'> {
  dbPath: string
}

export class YachiyoServer {
  private readonly storage: YachiyoStorage
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly listeners = new Set<(event: YachiyoServerEvent) => void>()
  private readonly memoryService: MemoryService
  private readonly configDomain: YachiyoServerConfigDomain
  private readonly runDomain: YachiyoServerRunDomain
  private readonly threadDomain: YachiyoServerThreadDomain
  private readonly browserSearchSession: BrowserSearchSession
  private readonly ensureThreadWorkspacePath: (threadId: string) => Promise<string>
  private readonly cloneThreadWorkspace: (
    sourceThreadId: string,
    targetThreadId: string
  ) => Promise<string>
  private readonly searchService: SearchService
  private readonly readUserDocumentFile: () => Promise<UserDocument | null>
  private readonly saveUserDocumentFile: (content: string) => Promise<UserDocument | null>
  private readonly readSoulDocumentFile: () => Promise<SoulDocument | null>

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
    this.readSoulDocumentFile = options.readSoulDocument ?? (() => readSoulDocument())
    this.readUserDocumentFile = options.readUserDocument ?? (() => readUserDocument())
    this.saveUserDocumentFile =
      options.saveUserDocument ?? ((content) => writeUserDocument({ content }))
    const searchService = options.searchService ?? createSearchService()
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
    const browserWebPageSnapshotLoader = createBrowserWebPageSnapshotLoader({
      browserSession: this.browserSearchSession
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
    const memoryService =
      options.memoryService ??
      createMemoryService({
        auxiliaryGeneration,
        createModelRuntime,
        createProvider: (config) => createNowledgeMemProvider(config),
        readConfig: () => this.configDomain.readConfig(),
        readSettings: () => this.configDomain.readSettings()
      })
    this.memoryService = memoryService
    this.ensureThreadWorkspacePath = ensureThreadWorkspace
    this.cloneThreadWorkspace = cloneThreadWorkspace
    this.searchService = searchService
    this.runDomain = new YachiyoServerRunDomain({
      storage: this.storage,
      createId: this.createId,
      timestamp: this.timestamp.bind(this),
      emit: this.emit.bind(this),
      auxiliaryGeneration,
      createModelRuntime,
      ensureThreadWorkspace,
      fetchImpl: options.fetchImpl,
      loadBrowserSnapshot: browserWebPageSnapshotLoader,
      searchService,
      webSearchService,
      memoryService,
      readSoulDocument: this.readSoulDocumentFile,
      readUserDocument: this.readUserDocumentFile,
      readConfig: () => this.configDomain.readConfig(),
      readSettings: () => this.configDomain.readSettings(),
      listSkills: (workspacePaths) => this.listSkills({ workspacePaths }),
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
      memoryService,
      requireThread: this.requireThread.bind(this),
      loadThreadMessages: (threadId) => this.storage.listThreadMessages(threadId),
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
    await Promise.all([this.readSoulDocumentFile(), this.readUserDocumentFile()])
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

  async getUserDocument(): Promise<UserDocument> {
    const document = await this.readUserDocumentFile()
    if (!document) {
      throw new Error('USER.md is unavailable.')
    }

    return document
  }

  async saveConfig(input: SettingsConfig): Promise<SettingsConfig> {
    return this.configDomain.saveConfig(input)
  }

  async saveUserDocument(input: { content: string }): Promise<UserDocument> {
    const document = await this.saveUserDocumentFile(input.content)
    if (!document) {
      throw new Error('Failed to save USER.md.')
    }

    return document
  }

  async testMemoryConnection(config: SettingsConfig): Promise<TestMemoryConnectionResult> {
    return this.memoryService.testConnection(config)
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

  async setDefaultProvider(input: { id?: string; name?: string }): Promise<SettingsConfig> {
    return this.configDomain.setDefaultProvider(input)
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

  async listSkills(input: ListSkillsInput = {}): Promise<SkillCatalogEntry[]> {
    return buildSkillRegistry(await discoverSkills(input.workspacePaths ?? []))
  }

  async searchWorkspaceFiles(input: SearchWorkspaceFilesInput): Promise<FileMentionCandidate[]> {
    const query = input.query.trim()

    let workspacePath = input.workspacePath?.trim() ?? ''
    if (!workspacePath && input.threadId) {
      const thread = this.requireThread(input.threadId)
      workspacePath = thread.workspacePath?.trim() ?? ''
      if (!workspacePath) {
        workspacePath = await this.ensureThreadWorkspacePath(thread.id)
      }
    }

    if (!workspacePath) {
      return []
    }

    const paths = await searchWorkspaceFileMentionCandidates({
      query,
      includeIgnored: input.includeIgnored,
      workspacePath: resolve(workspacePath),
      searchService: this.searchService,
      limit: input.limit
    })

    return paths.map((path) => ({ path }))
  }

  searchThreadsAndMessages(input: { query: string }): ThreadSearchResult[] {
    return this.storage.searchThreadsAndMessages(input)
  }

  async createThread(input: { workspacePath?: string } = {}): Promise<ThreadRecord> {
    return this.threadDomain.createThread(input)
  }

  async compactThreadToAnotherThread(input: CompactThreadInput): Promise<CompactThreadAccepted> {
    const sourceThread = this.requireThread(input.threadId)

    if (this.runDomain.hasActiveThread(sourceThread.id)) {
      throw new Error('Cannot compact a thread with an active run.')
    }

    const destinationThreadId = this.createId()

    if (!sourceThread.workspacePath) {
      await this.cloneThreadWorkspace(sourceThread.id, destinationThreadId)
    }

    let destinationThread = await this.threadDomain.createThread(
      sourceThread.workspacePath
        ? {
            threadId: destinationThreadId,
            workspacePath: sourceThread.workspacePath
          }
        : { threadId: destinationThreadId }
    )

    if (destinationThread.title !== sourceThread.title) {
      destinationThread = this.threadDomain.renameThread({
        threadId: destinationThread.id,
        title: sourceThread.title
      })
    }

    return this.runDomain.compactThreadToAnotherThread({
      sourceThread,
      destinationThread
    })
  }

  async updateThreadWorkspace(input: {
    threadId: string
    workspacePath?: string | null
  }): Promise<ThreadRecord> {
    return this.threadDomain.updateWorkspace(input)
  }

  async openThreadWorkspace(input: { threadId: string }): Promise<string> {
    const thread = this.requireThread(input.threadId)
    const workspacePath = thread.workspacePath?.trim()

    if (workspacePath) {
      const resolvedWorkspacePath = resolve(workspacePath)
      await mkdir(resolvedWorkspacePath, { recursive: true })
      return resolvedWorkspacePath
    }

    return defaultEnsureThreadWorkspace(thread.id)
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

  async saveThread(input: SaveThreadInput): Promise<SaveThreadResult> {
    return this.threadDomain.saveThread(input)
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
