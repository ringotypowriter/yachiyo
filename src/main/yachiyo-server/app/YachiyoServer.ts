import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type {
  BootstrapPayload,
  ChannelGroupRecord,
  ChannelUserRecord,
  ChatAccepted,
  CompactThreadAccepted,
  CompactThreadInput,
  CreateScheduleInput,
  EditMessageInput,
  FileMentionCandidate,
  GetMemoryTermDocumentInput,
  ImportWebSearchBrowserSessionInput,
  ListSkillsInput,
  ProviderConfig,
  ProviderSettings,
  RetryAccepted,
  RetryInput,
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
  ThreadModelOverride,
  ThreadRecord,
  ThreadSearchResult,
  ThreadSnapshot,
  ChannelsConfig,
  ToolCallRecord,
  ToolPreferencesInput,
  UpdateChannelGroupInput,
  UpdateChannelUserInput,
  UpdateScheduleInput,
  UserDocument,
  SoulDocument as ProtocolSoulDocument,
  WebSearchBrowserImportSource,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import {
  resolveYachiyoSettingsPath,
  resolveYachiyoTempWorkspaceRoot,
  resolveYachiyoWebSearchBrowserSessionPath
} from '../config/paths.ts'
import { ScheduleDomain } from './domain/scheduleDomain.ts'
import { createTtlReaper, type TtlReaper } from './domain/ttlReaper.ts'
import { createAuxiliaryGenerationService } from '../runtime/auxiliaryGeneration.ts'
import { searchWorkspaceFileMentionCandidates } from '../runtime/fileMentions.ts'
import { createAiSdkModelRuntime } from '../runtime/modelRuntime.ts'
import {
  readSoulDocument,
  upsertDailySoulTrait,
  removeSoulTrait,
  type SoulDocument
} from '../runtime/soul.ts'
import { readUserDocument, writeUserDocument } from '../runtime/user.ts'
import { readChannelsConfig, writeChannelsConfig } from '../runtime/channelsConfig.ts'
import type { ModelRuntime } from '../runtime/types.ts'
import { createSearchService, type SearchService } from '../services/search/searchService.ts'
import {
  createImageToTextService,
  type ImageToTextService
} from '../services/imageToText/imageToTextService.ts'
import { createMemoryService, type MemoryService } from '../services/memory/memoryService.ts'
import { readBuiltinMemoryTermDocument } from '../services/memory/builtinMemoryProvider.ts'
import { createMemoryProviderFactory } from '../services/memory/createMemoryProvider.ts'
import type { MemoryProvider } from '../services/memory/memoryService.ts'
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
import { createSettingsStore, toEffectiveProviderSettings } from '../settings/settingsStore.ts'
import { createSqliteYachiyoStorage } from '../storage/sqlite/database.ts'
import type { YachiyoStorage } from '../storage/storage.ts'
import {
  cloneThreadWorkspace as defaultCloneThreadWorkspace,
  deleteThreadWorkspace as defaultDeleteThreadWorkspace,
  ensureThreadWorkspace as defaultEnsureThreadWorkspace
} from '../threads/threadWorkspace.ts'
import { testSubagentProfile as runTestSubagentProfile } from '../tools/agentTools/testSubagentProfile.ts'
import { assertSupportedImages, YachiyoServerConfigDomain } from './domain/configDomain.ts'
import { YachiyoServerRunDomain } from './domain/runDomain.ts'
import { YachiyoServerThreadDomain } from './domain/threadDomain.ts'
import {
  hasMessagePayload,
  normalizeMessageImages
} from '../../../shared/yachiyo/messageContent.ts'

export interface YachiyoServerOptions {
  storage: YachiyoStorage
  settingsPath?: string
  fetchImpl?: typeof globalThis.fetch
  now?: () => Date
  createId?: () => string
  createModelRuntime?: () => ModelRuntime
  searchService?: SearchService
  readSoulDocument?: () => Promise<SoulDocument | null>
  addSoulTrait?: (trait: string) => Promise<SoulDocument | null>
  removeSoulTrait?: (trait: string) => Promise<SoulDocument | null>
  readUserDocument?: () => Promise<UserDocument | null>
  saveUserDocument?: (content: string) => Promise<UserDocument | null>
  readMemoryTermDocument?: () => Promise<MemoryTermDocument>
  ensureThreadWorkspace?: (threadId: string) => Promise<string>
  cloneThreadWorkspace?: (sourceThreadId: string, targetThreadId: string) => Promise<string>
  deleteThreadWorkspace?: (threadId: string) => Promise<void>
  memoryService?: MemoryService
  createMemoryProvider?: (config: SettingsConfig) => MemoryProvider
}

export interface SqliteYachiyoServerOptions extends Omit<YachiyoServerOptions, 'storage'> {
  dbPath: string
}

export class YachiyoServer {
  private readonly storage: YachiyoStorage
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly listeners = new Set<(event: YachiyoServerEvent) => void>()
  private readonly auxiliaryGeneration: import('../runtime/auxiliaryGeneration.ts').AuxiliaryGenerationService
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
  private readonly webSearchServiceInstance: import('../services/webSearch/webSearchService.ts').WebSearchService
  private readonly imageToTextServiceInstance: ImageToTextService
  private readonly readUserDocumentFile: () => Promise<UserDocument | null>
  private readonly saveUserDocumentFile: (content: string) => Promise<UserDocument | null>
  private readonly readMemoryTermDocumentFile: (() => Promise<MemoryTermDocument>) | null
  private readonly readSoulDocumentFile: () => Promise<SoulDocument | null>
  private readonly addSoulTraitFile: (trait: string) => Promise<SoulDocument | null>
  private readonly removeSoulTraitFile: (trait: string) => Promise<SoulDocument | null>
  private readonly scheduleDomain: ScheduleDomain
  private readonly ttlReaper: TtlReaper

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
    const auxiliaryGeneration = createAuxiliaryGenerationService({
      createModelRuntime,
      readToolModelSettings: () => this.configDomain.readToolModelSettings()
    })
    this.auxiliaryGeneration = auxiliaryGeneration
    this.imageToTextServiceInstance = createImageToTextService({
      auxService: auxiliaryGeneration,
      resolveSettings: () => {
        const channelsConfig = readChannelsConfig()
        const settingsConfig = this.configDomain.readConfig()
        const imageToTextModel = channelsConfig.imageToText?.model
        // Fall back to tool model settings when no override is configured.
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
    this.ensureThreadWorkspacePath = ensureThreadWorkspace
    this.cloneThreadWorkspace = cloneThreadWorkspace
    this.searchService = searchService
    this.webSearchServiceInstance = webSearchService
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
      isThreadRunning: (threadId) => this.runDomain.hasActiveThread(threadId),
      auxiliaryGeneration
    })

    this.scheduleDomain = new ScheduleDomain({
      storage: this.storage,
      createId: this.createId,
      timestamp: this.timestamp.bind(this)
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
    this.storage.close()
  }

  recoverInterruptedRuns(error?: string): void {
    this.runDomain.recoverInterruptedRuns(error)
  }

  recoverInterruptedSaves(): string[] {
    return this.storage.recoverInterruptedSaves()
  }

  async bootstrap(): Promise<BootstrapPayload> {
    this.recoverInterruptedRuns()
    const recoveredInterruptedSaveThreadIds = this.recoverInterruptedSaves()
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
      recoveredInterruptedSaveThreadIds,
      config: this.configDomain.readConfig(),
      settings: this.configDomain.readSettings()
    }
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

  async createThread(
    input: {
      workspacePath?: string
      source?: ThreadRecord['source']
      channelUserId?: string
      channelGroupId?: string
      title?: string
    } = {}
  ): Promise<ThreadRecord> {
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

    const destinationThread = await this.threadDomain.createThread({
      threadId: destinationThreadId,
      ...(sourceThread.workspacePath ? { workspacePath: sourceThread.workspacePath } : {}),
      ...(sourceThread.source && sourceThread.source !== 'local'
        ? { source: sourceThread.source }
        : {}),
      ...(sourceThread.channelUserId ? { channelUserId: sourceThread.channelUserId } : {}),
      ...(sourceThread.source && sourceThread.source !== 'local'
        ? { title: sourceThread.title }
        : {})
    })

    return this.runDomain.compactThreadToAnotherThread({
      sourceThread,
      destinationThread
    })
  }

  /**
   * Generate a rolling summary for an external channel thread in-place.
   * The thread continues with the same ID; old messages are covered by the summary.
   */
  async compactExternalThread(input: { threadId: string }): Promise<{ thread: ThreadRecord }> {
    const thread = this.requireThread(input.threadId)

    if (this.runDomain.hasActiveThread(thread.id)) {
      throw new Error('Cannot compact a thread with an active run.')
    }

    return this.runDomain.compactExternalThread({ thread })
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

  async archiveThread(input: { threadId: string; unread?: boolean }): Promise<void> {
    this.threadDomain.archiveThread(input)
  }

  markThreadAsRead(input: { threadId: string }): ThreadRecord {
    return this.threadDomain.markThreadAsRead(input)
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

  async editMessage(input: EditMessageInput): Promise<ChatAccepted> {
    // Validate payload before mutating history — avoids data loss if sendChat would reject
    const images = normalizeMessageImages(input.images)
    if (!hasMessagePayload({ content: input.content, images, attachments: input.attachments })) {
      throw new Error('Cannot send an empty message.')
    }
    assertSupportedImages(images)

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
      enabledSkillNames: input.enabledSkillNames
    })
    if ('userMessage' in accepted) {
      return { ...accepted, replacedMessageId: input.messageId }
    }
    return accepted
  }

  async cancelRun(input: { runId: string }): Promise<void> {
    this.runDomain.cancelRun(input)
  }

  loadThreadData(threadId: string): { messages: MessageRecord[]; toolCalls: ToolCallRecord[] } {
    return {
      messages: this.storage.listThreadMessages(threadId),
      toolCalls: this.storage.listThreadToolCalls(threadId)
    }
  }

  listExternalThreads(): ThreadRecord[] {
    return this.storage.listExternalThreads()
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
    return this.storage.findActiveGroupThread(channelGroupId, maxAgeMs)
  }

  getAuxiliaryGenerationService(): import('../runtime/auxiliaryGeneration.ts').AuxiliaryGenerationService {
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

  getWebSearchService(): import('../services/webSearch/webSearchService.ts').WebSearchService {
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
   * Used by channel services after reply extraction so rolling summary has clean input.
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
  getStorage(): import('../storage/storage.ts').YachiyoStorage {
    return this.storage
  }

  /** Generate a new unique ID. */
  generateId(): string {
    return this.createId()
  }

  // ---------------------------------------------------------------------------
  // Schedules
  // ---------------------------------------------------------------------------

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
    createMemoryProvider: createMemoryProviderFactory({
      builtinDbPath: options.dbPath
    }),
    readMemoryTermDocument: async () =>
      readBuiltinMemoryTermDocument({
        dbPath: options.dbPath
      }),
    storage: createSqliteYachiyoStorage(options.dbPath)
  })
}
