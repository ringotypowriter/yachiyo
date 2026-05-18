import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type {
  BootstrapPayload,
  ChannelGroupRecord,
  ChannelUserRecord,
  ChatAccepted,
  CompactThreadAccepted,
  CompactThreadInput,
  ComposerReasoningSelection,
  CreateScheduleInput,
  EditMessageInput,
  FileMentionCandidate,
  FolderColorTag,
  FolderRecord,
  GetMemoryTermDocumentInput,
  ImportWebSearchBrowserSessionInput,
  ListActivitySourceRecordsInput,
  ListSkillsInput,
  ProviderConfig,
  ProviderSettings,
  RetryAccepted,
  RetryInput,
  RunRecord,
  SaveThreadInput,
  SaveThreadResult,
  ScheduleRecord,
  ScheduleRunRecord,
  SearchWorkspaceFilesInput,
  SendChatInput,
  SettingsConfig,
  SkillCatalogEntry,
  MessageRecord,
  MemoryTermDocument,
  TestMemoryConnectionResult,
  TestSubagentProfileInput,
  TestSubagentProfileResult,
  ThreadColorTag,
  ThreadModelOverride,
  ThreadRecord,
  ThreadRuntimeBinding,
  ThreadSearchResult,
  ThreadSnapshot,
  ThreadStateReplacedEvent,
  ThreadUpdatedEvent,
  ChannelsConfig,
  ChannelGroupHistoryClearCompletedEvent,
  ChannelGroupHistoryClearFailedEvent,
  ChannelGroupHistoryClearStartedEvent,
  ToolCallRecord,
  ToolPreferencesInput,
  TranslateInput,
  TranslateResult,
  UpdateChannelGroupInput,
  UpdateChannelUserInput,
  UpdateScheduleInput,
  UserDocument,
  SoulDocument as ProtocolSoulDocument,
  UsageStatsInput,
  UsageStatsResponse,
  ActivitySourceRecord,
  WebSearchBrowserImportSource,
  YachiyoServerEvent
} from '../../../../shared/yachiyo/protocol.ts'
import {
  getThreadCapabilities,
  withThreadCapabilities
} from '../../../../shared/yachiyo/protocol.ts'
import {
  resolveThreadWorkspacePath as defaultResolveThreadWorkspacePath,
  resolveYachiyoSettingsPath,
  resolveYachiyoTempWorkspaceRoot,
  resolveYachiyoWebSearchBrowserSessionPath
} from '../../config/paths.ts'
import { FolderDomain } from '../domain/folders/folderDomain.ts'
import { ScheduleDomain } from '../domain/schedules/scheduleDomain.ts'
import { createTtlReaper, type TtlReaper } from '../domain/shared/ttlReaper.ts'
import { acpProcessPool } from '../../runtime/acp/acpProcessPool.ts'
import { createAuxiliaryGenerationService } from '../../runtime/models/auxiliaryGeneration.ts'
import { createAiSdkModelRuntime } from '../../runtime/models/modelRuntime.ts'
import {
  readSoulDocument,
  upsertDailySoulTrait,
  removeSoulTrait,
  type SoulDocument
} from '../../runtime/profiles/soul.ts'
import { readUserDocument, writeUserDocument } from '../../runtime/profiles/user.ts'
import { readChannelsConfig, writeChannelsConfig } from '../../runtime/config/channelsConfig.ts'
import type { ModelRuntime } from '../../runtime/models/types.ts'
import { resolveSearchBinaries } from '../../services/search/searchBinaries.ts'
import { createSearchService, type SearchService } from '../../services/search/searchService.ts'
import {
  createImageToTextService,
  type ImageToTextService
} from '../../services/imageToText/imageToTextService.ts'
import { createMemoryService, type MemoryService } from '../../services/memory/memoryService.ts'
import { createMemoryProviderFactory } from '../../services/memory/createMemoryProvider.ts'
import { discoverSkills } from '../../services/skills/skillDiscovery.ts'
import { buildSkillRegistry } from '../../services/skills/skillRegistry.ts'
import { createBrowserWebPageSnapshotLoader } from '../../services/webRead/browserWebPageSnapshot.ts'
import {
  BrowserSearchSession,
  createBrowserSearchSessionImportService,
  resolveGoogleChromeDataPath
} from '../../services/webSearch/browserSearchSession.ts'
import {
  createElectronBrowserSearchPageFactory,
  type BrowserSearchDiagnosticEvent
} from '../../services/webSearch/electronBrowserSearchSession.ts'
import { createGoogleBrowserWebSearchProvider } from '../../services/webSearch/providers/googleBrowserWebSearchProvider.ts'
import { createExaWebSearchProvider } from '../../services/webSearch/providers/exaWebSearchProvider.ts'
import { createWebSearchService } from '../../services/webSearch/webSearchService.ts'
import { createSettingsStore, toEffectiveProviderSettings } from '../../settings/settingsStore.ts'
import type { JotdownStore } from '../../services/jotdownStore.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import {
  cloneThreadWorkspace as defaultCloneThreadWorkspace,
  deleteThreadWorkspace as defaultDeleteThreadWorkspace,
  ensureThreadWorkspace as defaultEnsureThreadWorkspace
} from '../../threads/threadWorkspace.ts'
import { testSubagentProfile as runTestSubagentProfile } from '../../tools/agentTools/testSubagentProfile.ts'
import { assertSupportedImages, YachiyoServerConfigDomain } from '../domain/config/configDomain.ts'
import { YachiyoServerRunDomain } from '../domain/run/runDomain.ts'
import { YachiyoServerThreadDomain } from '../domain/threads/threadDomain.ts'
import {
  createRemoteImageDomain,
  type DownloadRemoteImageInput,
  type RemoteImageFetcher
} from '../domain/images/remoteImageDomain.ts'
import {
  hasMessagePayload,
  normalizeMessageImages
} from '../../../../shared/yachiyo/messageContent.ts'
import {
  formatConversationSummary,
  formatOwnerDmTakeoverContext,
  TAKEOVER_SECTION_DIVIDER,
  formatTakeoverTokens,
  formatTakeoverWorkspace,
  isBlankNewChatThread,
  isOwnerDmTakeoverCandidate
} from './takeoverContext.ts'
import {
  getBackgroundTaskLogTargetFromToolCalls,
  hydrateBackgroundTaskSnapshots,
  readBackgroundTaskLogSnapshot
} from './backgroundTasks.ts'
import {
  clearChannelGroupHistoryNow,
  startChannelGroupHistoryClear
} from './channelGroupHistory.ts'
import { searchYachiyoWorkspaceFiles } from './workspaceSearch.ts'
import { compactThreadWithHandoff, createThreadWithHandoffWorkspace } from './threadHandoff.ts'
import { translateWithRuntime } from './translate.ts'
import { openThreadWorkspacePath, pruneUnusedTemporaryWorkspaces } from './workspaces.ts'
import { bootstrapYachiyoServer } from './bootstrap.ts'
import { downloadRemoteImageAndBuildReplacementEvent } from './remoteImages.ts'
import { projectVisibleRunEvent, type YachiyoServerEventPayload } from './runEventProjection.ts'
import { createSqliteYachiyoServerOptions } from './sqliteFactoryOptions.ts'
import type { SqliteYachiyoServerOptions, YachiyoServerOptions } from './options.ts'

export class YachiyoServer {
  private readonly storage: YachiyoStorage
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly listeners = new Set<(event: YachiyoServerEvent) => void>()
  private readonly activeChannelGroupHistoryClears = new Set<string>()
  private readonly retiredGroupProbeThreadIdsByGroup = new Map<string, Set<string>>()
  private readonly auxiliaryGeneration: import('../../runtime/models/auxiliaryGeneration.ts').AuxiliaryGenerationService
  private readonly createModelRuntimeFn: () => ModelRuntime
  private readonly memoryService: MemoryService
  private readonly configDomain: YachiyoServerConfigDomain
  private readonly runDomain: YachiyoServerRunDomain
  private readonly threadDomain: YachiyoServerThreadDomain
  private readonly browserSearchSession: BrowserSearchSession
  private readonly resolveThreadWorkspacePath: (threadId: string) => string
  private readonly ensureThreadWorkspacePath: (threadId: string) => Promise<string>
  private readonly searchService: SearchService
  private readonly webSearchServiceInstance: import('../../services/webSearch/webSearchService.ts').WebSearchService
  private readonly imageToTextServiceInstance: ImageToTextService
  private readonly readUserDocumentFile: () => Promise<UserDocument | null>
  private readonly saveUserDocumentFile: (content: string) => Promise<UserDocument | null>
  private readonly readMemoryTermDocumentFile: (() => Promise<MemoryTermDocument>) | null
  private readonly readSoulDocumentFile: () => Promise<SoulDocument | null>
  private readonly addSoulTraitFile: (trait: string) => Promise<SoulDocument | null>
  private readonly removeSoulTraitFile: (trait: string) => Promise<SoulDocument | null>
  private readonly folderDomain: FolderDomain
  private readonly scheduleDomain: ScheduleDomain
  private readonly ttlReaper: TtlReaper
  private readonly jotdownStore: JotdownStore | null
  private readonly developmentMode: boolean
  private readonly remoteImageDomain: ReturnType<typeof createRemoteImageDomain>

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
    this.developmentMode = options.developmentMode === true
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID

    const settingsStore = createSettingsStore(
      options.settingsPath ?? resolveYachiyoSettingsPath(),
      { seedPresetProviders: options.seedPresetProviders }
    )
    const createModelRuntime =
      options.createModelRuntime ??
      (() => createAiSdkModelRuntime({ fetchImpl: options.fetchImpl }))
    this.readSoulDocumentFile = options.readSoulDocument ?? (() => readSoulDocument())
    this.addSoulTraitFile = options.addSoulTrait ?? ((trait) => upsertDailySoulTrait({ trait }))
    this.removeSoulTraitFile = options.removeSoulTrait ?? ((trait) => removeSoulTrait({ trait }))
    this.readUserDocumentFile = options.readUserDocument ?? (() => readUserDocument())
    this.saveUserDocumentFile =
      options.saveUserDocument ?? ((content) => writeUserDocument({ content }))
    this.readMemoryTermDocumentFile = options.readMemoryTermDocument ?? null
    const searchBinaries = resolveSearchBinaries()
    const searchService =
      options.searchService ??
      createSearchService({ rgPath: searchBinaries.rg, fdPath: searchBinaries.fd })
    const ensureThreadWorkspace = options.ensureThreadWorkspace ?? defaultEnsureThreadWorkspace
    const resolveThreadWorkspacePath =
      options.resolveThreadWorkspacePath ?? defaultResolveThreadWorkspacePath
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
        }),
        createExaWebSearchProvider({
          readConfig: () => this.configDomain.readConfig(),
          fetchImpl: options.fetchImpl
        })
      ],
      readConfig: () => this.configDomain.readConfig()
    })
    this.configDomain = new YachiyoServerConfigDomain({
      settingsStore,
      emit: this.emit.bind(this),
      fetchImpl: options.fetchImpl,
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
    this.createModelRuntimeFn = createModelRuntime
    const auxiliaryGeneration = createAuxiliaryGenerationService({
      createModelRuntime,
      readToolModelSettings: () => this.configDomain.readToolModelSettings()
    })
    this.auxiliaryGeneration = auxiliaryGeneration
    this.imageToTextServiceInstance = createImageToTextService({
      auxService: auxiliaryGeneration,
      resolveSettings: () => {
        const settingsConfig = this.configDomain.readConfig()
        const imageToTextModel = settingsConfig.chat?.imageToTextModel
        return imageToTextModel
          ? toEffectiveProviderSettings(settingsConfig, imageToTextModel)
          : (this.configDomain.readToolModelSettings() ??
              toEffectiveProviderSettings(settingsConfig, undefined))
      },
      lookupByHash: (hash) => this.storage.getImageAltText(hash),
      persist: (hash, altText) => this.storage.saveImageAltText(hash, altText)
    })
    const memoryService =
      options.memoryService ??
      createMemoryService({
        auxiliaryGeneration,
        createModelRuntime,
        createProvider: options.createMemoryProvider ?? createMemoryProviderFactory(),
        readConfig: () => this.configDomain.readConfig(),
        readSettings: () => this.configDomain.readSettings()
      })
    this.memoryService = memoryService
    this.resolveThreadWorkspacePath = resolveThreadWorkspacePath
    this.ensureThreadWorkspacePath = ensureThreadWorkspace
    this.searchService = searchService
    this.webSearchServiceInstance = webSearchService
    this.jotdownStore = options.jotdownStore ?? null
    this.runDomain = new YachiyoServerRunDomain({
      storage: this.storage,
      createId: this.createId,
      timestamp: this.timestamp.bind(this),
      emit: this.emit.bind(this),
      auxiliaryGeneration,
      createModelRuntime,
      ensureThreadWorkspace,
      fetchImpl: options.fetchImpl,
      webExternalFetchImpl: options.webExternalFetchImpl,
      loadBrowserSnapshot: browserWebPageSnapshotLoader,
      searchService,
      webSearchService,
      memoryService,
      sourceQueryExecutor: options.sourceQueryExecutor,
      readSoulDocument: this.readSoulDocumentFile,
      readUserDocument: this.readUserDocumentFile,
      readConfig: () => this.configDomain.readConfig(),
      readSettings: () => this.configDomain.readSettings(),
      runInactivityTimeoutMs: options.runInactivityTimeoutMs ?? 45_000,
      listSkills: (workspacePaths) => this.listSkills({ workspacePaths }),
      requireThread: this.requireThread.bind(this),
      loadThreadMessages: (threadId) => this.storage.listThreadMessages(threadId),
      loadThreadToolCalls: (threadId) => this.storage.listThreadToolCalls(threadId),
      jotdownStore: this.jotdownStore ?? undefined,
      imageToTextService: this.imageToTextServiceInstance
    })
    this.threadDomain = new YachiyoServerThreadDomain({
      storage: this.storage,
      createId: this.createId,
      timestamp: this.timestamp.bind(this),
      emit: this.emit.bind(this),
      resolveThreadWorkspacePath,
      ensureThreadWorkspace,
      cloneThreadWorkspace,
      deleteThreadWorkspace,
      memoryService,
      requireThread: this.requireThread.bind(this),
      loadThreadMessages: (threadId) => this.storage.listThreadMessages(threadId),
      isThreadRunning: (threadId) => this.runDomain.hasActiveThread(threadId),
      restoreActiveRunBranchWorkspace: (input) =>
        this.runDomain.restoreActiveRunBranchWorkspace(input),
      auxiliaryGeneration,
      evictAcpIdleThread: (threadId) => acpProcessPool.evictThread(threadId),
      cancelMemoryDistillation: (threadId) => this.runDomain.cancelMemoryDistillation(threadId),
      clearReadRecordCache: (threadId) => this.runDomain.clearReadRecordCache(threadId)
    })

    this.folderDomain = new FolderDomain({
      storage: this.storage,
      createId: this.createId,
      timestamp: this.timestamp.bind(this),
      emit: this.emit.bind(this)
    })

    this.scheduleDomain = new ScheduleDomain({
      storage: this.storage,
      createId: this.createId,
      timestamp: this.timestamp.bind(this)
    })
    this.scheduleDomain.ensureBundledSchedules()

    const externalFetchImpl = options.webExternalFetchImpl ?? options.fetchImpl ?? globalThis.fetch
    const defaultFetcher: RemoteImageFetcher = async (url) => {
      const response = await externalFetchImpl(url, { redirect: 'follow' })
      if (!response.ok) {
        throw new Error(`Remote image fetch failed: ${response.status} ${response.statusText}`)
      }
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
      const buffer = new Uint8Array(await response.arrayBuffer())
      return { contentType, bytes: buffer }
    }
    this.remoteImageDomain = createRemoteImageDomain({
      storage: this.storage,
      fetchRemoteImage: options.remoteImageFetcher ?? defaultFetcher
    })

    this.ttlReaper = createTtlReaper({
      manifestPath: join(resolveYachiyoTempWorkspaceRoot(), '.yachiyo-ttl.json')
    })
  }

  subscribe(listener: (event: YachiyoServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getTtlReaper(): TtlReaper {
    return this.ttlReaper
  }

  async close(): Promise<void> {
    this.ttlReaper.stop()
    await this.runDomain.close()
    await acpProcessPool.shutdown()
    await this.storage.flushBackgroundTasks?.()
    this.storage.close()
  }

  recoverInterruptedRuns(error?: string): void {
    this.runDomain.recoverInterruptedRuns(error)
  }

  recoverInterruptedSaves(): string[] {
    return this.storage.recoverInterruptedSaves()
  }

  async bootstrap(): Promise<BootstrapPayload> {
    return bootstrapYachiyoServer({
      configDomain: this.configDomain,
      developmentMode: this.developmentMode,
      readSoulDocument: this.readSoulDocumentFile,
      readUserDocument: this.readUserDocumentFile,
      recoverInterruptedRuns: () => this.recoverInterruptedRuns(),
      recoverInterruptedSaves: () => this.recoverInterruptedSaves(),
      runDomain: this.runDomain,
      storage: this.storage
    })
  }

  async getConfig(): Promise<SettingsConfig> {
    return this.configDomain.getConfig()
  }

  private toProtocolSoulDocument(doc: SoulDocument): ProtocolSoulDocument {
    return {
      filePath: doc.filePath,
      evolvedTraits: doc.evolvedTraits,
      lastUpdated: doc.lastUpdated
    }
  }

  async getSoulDocument(): Promise<ProtocolSoulDocument> {
    const doc = await this.readSoulDocumentFile()
    if (!doc) {
      throw new Error('SOUL.md is unavailable.')
    }

    return this.toProtocolSoulDocument(doc)
  }

  async addSoulTrait(input: { trait: string }): Promise<ProtocolSoulDocument> {
    const doc = await this.addSoulTraitFile(input.trait)
    if (!doc) {
      throw new Error('Failed to add soul trait.')
    }

    return this.toProtocolSoulDocument(doc)
  }

  async deleteSoulTrait(input: { trait: string }): Promise<ProtocolSoulDocument> {
    const doc = await this.removeSoulTraitFile(input.trait)
    if (!doc) {
      throw new Error('Failed to remove soul trait.')
    }

    return this.toProtocolSoulDocument(doc)
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

  async getMemoryTermDocument(input?: GetMemoryTermDocumentInput): Promise<MemoryTermDocument> {
    const provider = (input?.config ?? this.configDomain.readConfig()).memory?.provider
    if (provider !== 'builtin-memory' || !this.readMemoryTermDocumentFile) {
      throw new Error('Built-in memory terms are unavailable.')
    }

    return this.readMemoryTermDocumentFile()
  }

  listActivitySourceRecords(input?: ListActivitySourceRecordsInput): ActivitySourceRecord[] {
    const limit =
      typeof input?.limit === 'number' && Number.isFinite(input.limit)
        ? Math.min(Math.max(Math.floor(input.limit), 1), 200)
        : 50
    return this.storage.listActivitySourceRecords({ limit })
  }

  async testMemoryConnection(config: SettingsConfig): Promise<TestMemoryConnectionResult> {
    return this.memoryService.testConnection(config)
  }

  async testSubagentProfile(input: TestSubagentProfileInput): Promise<TestSubagentProfileResult> {
    return runTestSubagentProfile(input.profile)
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
    return searchYachiyoWorkspaceFiles({
      ensureThreadWorkspace: this.ensureThreadWorkspacePath,
      jotdownStore: this.jotdownStore,
      requireThread: this.requireThread.bind(this),
      searchInput: input,
      searchService: this.searchService
    })
  }

  searchThreadsAndMessages(input: { query: string }): ThreadSearchResult[] {
    return this.storage.searchThreadsAndMessages(input)
  }

  async createThread(
    input: {
      workspacePath?: string
      source?: ThreadRecord['source']
      channelUserId?: string
      channelGroupId?: string
      title?: string
      createdFromEssentialId?: string
      createdFromScheduleId?: string
      handoffFromThreadId?: string
      privacyMode?: boolean
      reasoningEffort?: ComposerReasoningSelection
    } = {}
  ): Promise<ThreadRecord> {
    return createThreadWithHandoffWorkspace({
      createId: this.createId,
      payload: input,
      requireThread: this.requireThread.bind(this),
      resolveThreadWorkspacePath: this.resolveThreadWorkspacePath,
      threadDomain: this.threadDomain
    })
  }

  async compactThreadToAnotherThread(input: CompactThreadInput): Promise<CompactThreadAccepted> {
    return compactThreadWithHandoff({
      createId: this.createId,
      folderDomain: this.folderDomain,
      payload: input,
      requireThread: this.requireThread.bind(this),
      resolveThreadWorkspacePath: this.resolveThreadWorkspacePath,
      runDomain: this.runDomain,
      threadDomain: this.threadDomain
    })
  }

  async updateThreadWorkspace(input: {
    threadId: string
    workspacePath?: string | null
  }): Promise<ThreadRecord> {
    return this.threadDomain.updateWorkspace(input)
  }

  getThreadWorkspaceChangeBlocker(input: { threadId: string }): string | null {
    return this.threadDomain.getWorkspaceChangeBlocker(input)
  }

  async openThreadWorkspace(input: { threadId: string }): Promise<string> {
    return openThreadWorkspacePath({
      ensureThreadWorkspace: defaultEnsureThreadWorkspace,
      thread: this.requireThread(input.threadId)
    })
  }

  async createFolderForThreads(input: { threadIds: string[] }): Promise<FolderRecord> {
    const threads = input.threadIds.map((id) => this.requireThread(id))
    return this.folderDomain.createFolderForThreads({ threads })
  }

  async renameFolder(input: { folderId: string; title: string }): Promise<FolderRecord> {
    return this.folderDomain.renameFolder(input)
  }

  async setFolderColor(input: {
    folderId: string
    colorTag: FolderColorTag | null
  }): Promise<FolderRecord> {
    return this.folderDomain.setFolderColor(input)
  }

  async deleteFolder(input: { folderId: string }): Promise<void> {
    this.folderDomain.deleteFolder(input.folderId)
  }

  async moveThreadToFolder(input: {
    threadId: string
    folderId: string | null
  }): Promise<ThreadRecord> {
    return this.folderDomain.moveThreadToFolder(input)
  }

  async renameThread(input: { threadId: string; title: string }): Promise<ThreadRecord> {
    return this.threadDomain.renameThread(input)
  }

  async setThreadColor(input: {
    threadId: string
    colorTag: ThreadColorTag | null
  }): Promise<ThreadRecord> {
    return this.threadDomain.setThreadColor(input)
  }

  async setThreadIcon(input: { threadId: string; icon: string | null }): Promise<ThreadRecord> {
    return this.threadDomain.setThreadIcon(input)
  }

  async starThread(input: { threadId: string; starred: boolean }): Promise<ThreadRecord> {
    return this.threadDomain.starThread(input)
  }

  async regenerateThreadTitle(input: { threadId: string }): Promise<ThreadRecord> {
    return this.threadDomain.regenerateThreadTitle(input)
  }

  async setThreadPrivacyMode(input: { threadId: string; enabled: boolean }): Promise<ThreadRecord> {
    return this.threadDomain.setThreadPrivacyMode(input)
  }

  async setThreadModelOverride(input: {
    threadId: string
    modelOverride: ThreadModelOverride | null
  }): Promise<ThreadRecord> {
    return this.threadDomain.setThreadModelOverride(input)
  }

  async setThreadReasoningEffort(input: {
    threadId: string
    reasoningEffort: ComposerReasoningSelection | null
  }): Promise<ThreadRecord> {
    return this.threadDomain.setThreadReasoningEffort(input)
  }

  async setThreadRuntimeBinding(input: {
    threadId: string
    runtimeBinding: ThreadRuntimeBinding | null
  }): Promise<ThreadRecord> {
    return this.threadDomain.setThreadRuntimeBinding(input)
  }

  async archiveThread(input: { threadId: string; unread?: boolean }): Promise<void> {
    this.threadDomain.archiveThread(input)
  }

  markThreadAsRead(input: { threadId: string }): ThreadRecord {
    return this.threadDomain.markThreadAsRead(input)
  }

  markThreadReviewed(input: { threadId: string }): void {
    this.storage.markThreadReviewed({
      threadId: input.threadId,
      reviewedAt: new Date().toISOString()
    })
  }

  async restoreThread(input: { threadId: string }): Promise<ThreadRecord> {
    return this.threadDomain.restoreThread(input)
  }

  async deleteThread(input: { threadId: string }): Promise<void> {
    await this.threadDomain.deleteThread(input)
  }

  async pruneEmptyTemporaryWorkspaces(): Promise<number> {
    const { threads, archivedThreads } = this.storage.bootstrap()
    return pruneUnusedTemporaryWorkspaces({ threads, archivedThreads })
  }

  clearRecapText(input: { threadId: string }): void {
    const thread = this.storage.getThread(input.threadId)
    if (thread?.recapText) {
      this.storage.updateThread({ ...thread, recapText: undefined })
    }
  }

  async requestRecap(input: { threadId: string }): Promise<string | null> {
    return this.runDomain.requestRecap(input)
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
    const sourceThread = this.requireThread(input.threadId)
    const result = await this.threadDomain.createBranch(input)

    // Auto-categorize: group source and branch under a folder
    if (!sourceThread.source || sourceThread.source === 'local') {
      this.folderDomain.ensureFolderForDerivedThread({
        sourceThread,
        derivedThread: result.thread
      })
    }

    return result
  }

  async deleteMessageFromHere(input: {
    threadId: string
    messageId: string
  }): Promise<ThreadSnapshot> {
    const queuedDraftSnapshot = this.runDomain.deleteQueuedFollowUpDraft(input)
    if (queuedDraftSnapshot) {
      return queuedDraftSnapshot
    }
    return this.threadDomain.deleteMessageFromHere(input)
  }

  async editMessage(input: EditMessageInput): Promise<ChatAccepted> {
    // Validate payload before mutating history — avoids data loss if sendChat would reject
    const images = normalizeMessageImages(input.images)
    if (!hasMessagePayload({ content: input.content, images, attachments: input.attachments })) {
      throw new Error('Cannot send an empty message.')
    }
    assertSupportedImages(images)
    const thread = this.requireThread(input.threadId)
    if (!getThreadCapabilities(thread).canEdit) {
      throw new Error('ACP threads do not support editing messages.')
    }

    this.threadDomain.deleteMessageFromHere({
      threadId: input.threadId,
      messageId: input.messageId
    })
    const accepted = await this.runDomain.sendChat({
      threadId: input.threadId,
      content: input.content,
      images: input.images,
      attachments: input.attachments,
      enabledTools: input.enabledTools,
      enabledSkillNames: input.enabledSkillNames,
      runMode: input.runMode,
      reasoningEffort: input.reasoningEffort
    })
    if ('userMessage' in accepted) {
      return { ...accepted, replacedMessageId: input.messageId }
    }
    return accepted
  }

  async downloadRemoteImageForMessage(
    input: DownloadRemoteImageInput
  ): Promise<{ absPath: string; message: MessageRecord }> {
    return downloadRemoteImageAndBuildReplacementEvent({
      download: this.remoteImageDomain,
      emit: (event) => this.emit<ThreadStateReplacedEvent>(event),
      getMessages: (threadId) => this.storage.listThreadMessages(threadId),
      getThread: (threadId) => this.requireThread(threadId),
      getToolCalls: (threadId) => this.storage.listThreadToolCalls(threadId),
      request: input
    })
  }

  async cancelRun(input: { runId: string }): Promise<void> {
    this.runDomain.cancelRun(input)
  }

  withdrawPendingSteer(input: { threadId: string }): void {
    this.runDomain.withdrawPendingSteer(input.threadId)
  }

  cancelRunForThread(threadId: string): boolean {
    return this.runDomain.cancelRunForThread(threadId)
  }

  cancelRunForChannelUser(channelUserId: string): boolean {
    return this.runDomain.cancelRunForChannelUser(channelUserId)
  }

  hasActiveThread(threadId: string): boolean {
    return this.runDomain.hasActiveThread(threadId)
  }

  listActiveRunIds(): string[] {
    return this.runDomain.listActiveRunIds()
  }

  cancelActiveRuns(): void {
    this.runDomain.cancelActiveRuns()
  }

  answerToolQuestion(input: { runId: string; toolCallId: string; answer: string }): void {
    this.runDomain.answerToolQuestion(input)
  }

  cancelBackgroundTask(input: { taskId: string }): boolean {
    return this.runDomain.cancelBackgroundTask(input.taskId)
  }

  async listBackgroundTasks(
    input: {
      threadId?: string
    } = {}
  ): Promise<import('../../../../shared/yachiyo/protocol').BackgroundTaskSnapshot[]> {
    return hydrateBackgroundTaskSnapshots(this.runDomain.listBackgroundTasks(input.threadId))
  }

  async getBackgroundTaskLog(input: {
    threadId: string
    taskId: string
    maxBytes?: number
  }): Promise<import('../../../../shared/yachiyo/protocol').BackgroundTaskLogSnapshot> {
    const target =
      this.runDomain.getBackgroundTaskLogTarget(input) ??
      getBackgroundTaskLogTargetFromToolCalls(
        this.storage.listThreadToolCalls(input.threadId),
        input
      )
    if (!target) {
      throw new Error(`Background task ${input.taskId} is not available.`)
    }

    return readBackgroundTaskLogSnapshot(target, input.maxBytes)
  }

  loadThreadData(threadId: string): {
    messages: MessageRecord[]
    toolCalls: ToolCallRecord[]
    runs: RunRecord[]
    scheduleRun?: ScheduleRunRecord
  } {
    const scheduleRun = this.storage.getScheduleRunByThreadId(threadId)
    return {
      messages: this.storage.listThreadMessages(threadId),
      toolCalls: this.storage.listThreadToolCalls(threadId),
      runs: this.storage.listThreadRuns(threadId),
      ...(scheduleRun ? { scheduleRun } : {})
    }
  }

  listExternalThreads(): ThreadRecord[] {
    return this.storage.listExternalThreads()
  }

  listOwnerDmTakeoverThreads(input: { channelUserId: string; limit: number }): ThreadRecord[] {
    const { threads, messagesByThread } = this.storage.bootstrap()
    return threads
      .filter(
        (thread) =>
          isOwnerDmTakeoverCandidate(thread) &&
          !isBlankNewChatThread(thread, messagesByThread[thread.id] ?? [])
      )
      .slice(0, Math.max(0, input.limit))
  }

  async takeOverThreadForChannelUser(input: {
    threadId: string
    channelUser: ChannelUserRecord
  }): Promise<ThreadRecord> {
    if (input.channelUser.role !== 'owner') {
      throw new Error('Only owner DMs can take over threads.')
    }

    const thread = this.requireThread(input.threadId)
    if (!isOwnerDmTakeoverCandidate(thread)) {
      throw new Error('This thread cannot be taken over from owner DM.')
    }
    if (this.runDomain.hasActiveThread(thread.id)) {
      throw new Error('Cannot take over a thread while it is running.')
    }

    const updatedThread = withThreadCapabilities({
      ...thread,
      channelUserId: input.channelUser.id,
      channelUserRole: input.channelUser.role,
      updatedAt: this.timestamp()
    })
    delete updatedThread.channelGroupId

    this.storage.updateThread(updatedThread)
    this.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })

    return updatedThread
  }

  buildThreadTakeoverContext(input: { threadId: string; contextTokenLimit: number }): string {
    const thread = this.requireThread(input.threadId)
    const context = formatOwnerDmTakeoverContext({
      thread,
      messages: this.storage.listThreadMessages(thread.id),
      toolCalls: this.storage.listThreadToolCalls(thread.id)
    })
    const workspace = thread.workspacePath
      ? formatTakeoverWorkspace(thread.workspacePath, this.configDomain.readConfig())
      : 'temporary'
    const tokens = this.storage.getThreadTotalTokens(thread.id)

    return [
      context,
      '',
      TAKEOVER_SECTION_DIVIDER,
      '',
      'Workspace:',
      workspace,
      '',
      'Context:',
      formatTakeoverTokens(tokens, input.contextTokenLimit)
    ].join('\n')
  }

  buildConversationSummary(threadId: string): string {
    const thread = this.requireThread(threadId)
    return formatConversationSummary({
      thread,
      messages: this.storage.listThreadMessages(thread.id),
      toolCalls: this.storage.listThreadToolCalls(thread.id)
    })
  }

  findActiveChannelThread(channelUserId: string, maxAgeMs: number): ThreadRecord | undefined {
    return this.storage.findActiveChannelThread(channelUserId, maxAgeMs)
  }

  getThreadTotalTokens(threadId: string): number {
    return this.storage.getThreadTotalTokens(threadId)
  }

  listChannelUsers(): ChannelUserRecord[] {
    return this.storage.listChannelUsers()
  }

  createChannelUser(user: Omit<ChannelUserRecord, 'usedKTokens'>): ChannelUserRecord {
    return this.storage.createChannelUser(user)
  }

  updateChannelUser(input: UpdateChannelUserInput): ChannelUserRecord {
    const updated = this.storage.updateChannelUser(input)
    if (!updated) {
      throw new Error(`Unknown channel user: ${input.id}`)
    }
    return updated
  }

  // ------------------------------------------------------------------
  // Channel groups (group discussion mode)
  // ------------------------------------------------------------------

  listChannelGroups(): ChannelGroupRecord[] {
    return this.storage.listChannelGroups()
  }

  findChannelGroup(
    platform: ChannelGroupRecord['platform'],
    externalGroupId: string
  ): ChannelGroupRecord | undefined {
    return this.storage.findChannelGroup(platform, externalGroupId)
  }

  createChannelGroup(group: Omit<ChannelGroupRecord, 'createdAt'>): ChannelGroupRecord {
    return this.storage.createChannelGroup(group)
  }

  updateChannelGroup(input: UpdateChannelGroupInput): ChannelGroupRecord {
    const updated = this.storage.updateChannelGroup(input)
    if (!updated) {
      throw new Error(`Unknown channel group: ${input.id}`)
    }
    return updated
  }

  findActiveGroupThread(channelGroupId: string, maxAgeMs: number): ThreadRecord | undefined {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
    const retiredIds = this.retiredGroupProbeThreadIdsByGroup.get(channelGroupId)

    return this.storage
      .listThreadsByChannelGroupId(channelGroupId)
      .find((thread) => thread.updatedAt >= cutoff && !retiredIds?.has(thread.id))
  }

  async clearChannelGroupHistory(input: { groupId: string }): Promise<void> {
    clearChannelGroupHistoryNow({
      groupId: input.groupId,
      now: this.now,
      storage: this.storage
    })
  }

  startClearChannelGroupHistory(input: { groupId: string }): boolean {
    return startChannelGroupHistoryClear({
      activeClears: this.activeChannelGroupHistoryClears,
      emit: (event) => {
        if (event.type === 'channel-group-history-clear.started') {
          this.emit<ChannelGroupHistoryClearStartedEvent>(event)
          return
        }
        if (event.type === 'channel-group-history-clear.completed') {
          this.emit<ChannelGroupHistoryClearCompletedEvent>(event)
          return
        }
        this.emit<ChannelGroupHistoryClearFailedEvent>(event)
      },
      groupId: input.groupId,
      now: this.now,
      retiredThreadIdsByGroup: this.retiredGroupProbeThreadIdsByGroup,
      storage: this.storage
    })
  }

  getAuxiliaryGenerationService(): import('../../runtime/models/auxiliaryGeneration.ts').AuxiliaryGenerationService {
    return this.auxiliaryGeneration
  }

  /**
   * Resolve full provider settings from an optional model override.
   * Falls back to the default primary model when no override is given.
   */
  resolveProviderSettings(modelOverride?: ThreadModelOverride): ProviderSettings {
    return toEffectiveProviderSettings(this.configDomain.readConfig(), modelOverride)
  }

  getMemoryService(): MemoryService {
    return this.memoryService
  }

  getWebSearchService(): import('../../services/webSearch/webSearchService.ts').WebSearchService {
    return this.webSearchServiceInstance
  }

  getImageToTextService(): ImageToTextService {
    return this.imageToTextServiceInstance
  }

  getChannelsConfig(): ChannelsConfig {
    return readChannelsConfig()
  }

  saveChannelsConfig(config: ChannelsConfig): ChannelsConfig {
    return writeChannelsConfig(config)
  }

  /**
   * Store the extracted visible reply on the latest assistant message in a thread.
   * Used by channel services after reply extraction so external replay uses clean output.
   */
  updateLatestAssistantVisibleReply(input: { threadId: string; visibleReply: string }): void {
    const messages = this.storage.listThreadMessages(input.threadId)
    const latest = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.status === 'completed')
    if (latest) {
      this.storage.updateMessage({ ...latest, visibleReply: input.visibleReply })
    }
  }

  /** Expose storage for schedule service (and future internal callers). */
  getStorage(): import('../../storage/storage.ts').YachiyoStorage {
    return this.storage
  }

  /** Generate a new unique ID. */
  generateId(): string {
    return this.createId()
  }

  listSchedules(): ScheduleRecord[] {
    return this.scheduleDomain.listSchedules()
  }

  getSchedule(id: string): ScheduleRecord {
    return this.scheduleDomain.getSchedule(id)
  }

  createSchedule(input: CreateScheduleInput): ScheduleRecord {
    return this.scheduleDomain.createSchedule(input)
  }

  updateSchedule(input: UpdateScheduleInput): ScheduleRecord {
    return this.scheduleDomain.updateSchedule(input)
  }

  deleteSchedule(id: string): void {
    this.scheduleDomain.deleteSchedule(id)
  }

  enableSchedule(id: string): boolean {
    return this.scheduleDomain.enableSchedule(id)
  }

  disableSchedule(id: string): ScheduleRecord {
    return this.scheduleDomain.disableSchedule(id)
  }

  listScheduleRuns(scheduleId: string, limit?: number): ScheduleRunRecord[] {
    return this.scheduleDomain.listScheduleRuns(scheduleId, limit)
  }

  listRecentScheduleRuns(limit?: number): ScheduleRunRecord[] {
    return this.scheduleDomain.listRecentScheduleRuns(limit)
  }

  getUsageStats(input: UsageStatsInput): UsageStatsResponse {
    return this.storage.getUsageStats(input)
  }

  async translateStream(
    input: TranslateInput,
    onDelta: (delta: string) => void
  ): Promise<TranslateResult> {
    return translateWithRuntime({
      createModelRuntime: this.createModelRuntimeFn,
      onDelta,
      request: input,
      settings: this.configDomain.readToolModelSettings()
    })
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
    const payload = event as YachiyoServerEventPayload
    const projectedEvent = projectVisibleRunEvent({ event: payload, runDomain: this.runDomain })
    const completeEvent = {
      eventId: this.createId(),
      timestamp: this.timestamp(),
      ...projectedEvent
    } as TEvent

    for (const listener of this.listeners) {
      listener(completeEvent)
    }
  }
}

export function createSqliteYachiyoServer(options: SqliteYachiyoServerOptions): YachiyoServer {
  return new YachiyoServer(createSqliteYachiyoServerOptions(options))
}
