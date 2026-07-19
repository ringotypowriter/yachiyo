/* eslint-disable yachiyo/max-typescript-file-lines */
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'

import type {
  BootstrapPayload,
  ChannelGroupRecord,
  ChannelUserRecord,
  ChatAccepted,
  CompactThreadAccepted,
  CompactThreadInput,
  ComposerReasoningSelection,
  CreateScheduleInput,
  DeleteMemoryTermInput,
  DeleteMemoryTermResult,
  EditMessageInput,
  FileMentionCandidate,
  FolderColorTag,
  FolderRecord,
  GetMemoryTermDocumentInput,
  ImportWebSearchBrowserSessionInput,
  ListActivitySourceRecordsInput,
  ListActivitySourceRecordsResult,
  ListSkillsInput,
  ProviderConfig,
  ProviderSettings,
  RenameThingInput,
  RemoveThingSourceInput,
  RetryAccepted,
  RetryInput,
  RunModeId,
  RunRecord,
  SaveThreadInput,
  SaveThreadResult,
  ReadThreadPlanDocumentInput,
  ReadThreadPlanDocumentResult,
  AcceptThreadPlanDocumentInput,
  ScheduleRecord,
  ScheduleRunRecord,
  SearchWorkspaceFilesInput,
  SettingsConfig,
  SkillCatalogEntry,
  ListSyncConflictsResult,
  MessageRecord,
  MemoryTermDocument,
  ResolveSyncConflictInput,
  TestSubagentProfileInput,
  TestSubagentProfileResult,
  ThreadColorTag,
  ThreadModelOverride,
  ThreadRecord,
  ThreadRuntimeBinding,
  ThingRecord,
  ThreadWorkspaceChangeDecision,
  ThreadWorkspaceChangeDecisionInput,
  ThreadWorkspaceUpdateInput,
  SearchThreadsAndMessagesInput,
  ThreadSearchResult,
  ThreadSnapshot,
  ThreadStateReplacedEvent,
  ThreadUpdatedEvent,
  ThingsUpdatedEvent,
  ToolCallName,
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
  SyncConflictRecord,
  SyncStatus,
  UsageStatsInput,
  UsageStatsResponse,
  WebSearchBrowserImportSource,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import { getThreadCapabilities, withThreadCapabilities } from '@yachiyo/shared/protocol'
import {
  resolveThreadWorkspacePath as defaultResolveThreadWorkspacePath,
  resolveYachiyoSettingsPath,
  resolveYachiyoTempWorkspaceRoot,
  resolveYachiyoWebSearchBrowserSessionPath
} from '../../config/paths.ts'
import { FolderDomain } from '../domain/folders/folderDomain.ts'
import { ScheduleDomain } from '../domain/schedules/scheduleDomain.ts'
import { ThingDomain } from '../domain/things/thingDomain.ts'
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
import {
  createInMemoryCognitiveMemoryStore,
  type CognitiveMemoryStore
} from '../../services/memory/cognitiveMemoryStore.ts'
import { createMemoryService, type MemoryService } from '../../services/memory/memoryService.ts'
import { createCachedSkillCatalogLoader } from '../../services/skills/skillCatalogCache.ts'
import { discoverSkills } from '../../services/skills/skillDiscovery.ts'
import { buildSkillRegistry } from '../../services/skills/skillRegistry.ts'
import { createBrowserWebPageSnapshotLoader } from '../../services/webRead/browserWebPageSnapshot.ts'
import {
  BrowserSearchSession,
  createBrowserSearchSessionImportService,
  resolveGoogleChromeDataPath,
  unavailableBrowserSearchPageFactory
} from '../../services/webSearch/browserSearchSession.ts'
import { createDuckDuckGoBrowserWebSearchProvider } from '../../services/webSearch/providers/duckDuckGoBrowserWebSearchProvider.ts'
import { createGoogleBrowserWebSearchProvider } from '../../services/webSearch/providers/googleBrowserWebSearchProvider.ts'
import { createExaWebSearchProvider } from '../../services/webSearch/providers/exaWebSearchProvider.ts'
import { createWebSearchService } from '../../services/webSearch/webSearchService.ts'
import {
  createSettingsStore,
  normalizeSettingsConfig,
  parseSettingsToml,
  toEffectiveProviderSettings
} from '../../settings/settingsStore.ts'
import { diffSettings, mergeSettings } from '../../settings/settingsFieldMerge.ts'
import { decideSettingsConflict } from '../../services/settingsConflictReconcile.ts'
import type { JotdownStore } from '../../services/jotdownStore.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import {
  resolveRecommendedICloudSyncDir,
  resolveSyncReadiness as resolveHostSyncReadiness
} from './syncReadiness.ts'
import {
  cloneThreadWorkspace as defaultCloneThreadWorkspace,
  deleteThreadWorkspace as defaultDeleteThreadWorkspace,
  ensureThreadWorkspace as defaultEnsureThreadWorkspace
} from '../../threads/threadWorkspace.ts'
import { testSubagentProfile as runTestSubagentProfile } from '../../tools/agentTools/testSubagentProfile.ts'
import { assertSupportedImages, YachiyoServerConfigDomain } from '../domain/config/configDomain.ts'
import { YachiyoServerRunDomain } from '../domain/run/runDomain.ts'
import type { InternalSendChatInput } from '../domain/run/runTypes.ts'
import {
  createThreadSentinelManager,
  type ThreadSentinelManager
} from '../domain/sentinel/threadSentinelManager.ts'
import { YachiyoServerThreadDomain } from '../domain/threads/threadDomain.ts'
import {
  createRemoteImageDomain,
  type DownloadRemoteImageInput,
  type RemoteImageFetcher
} from '../domain/images/remoteImageDomain.ts'
import { hasMessagePayload, normalizeMessageImages } from '@yachiyo/shared/messageContent'
import { messageRowId } from '@yachiyo/shared/sourceRowIds'
import { collectThingMentionSlugs } from '@yachiyo/shared/thingMentions'
import {
  getThreadPlanDocumentFilename,
  getThreadPlanDocumentStateFilename,
  type ThreadPlanDocumentStateFile,
  PLAN_DOCUMENT_DIR_NAME
} from '@yachiyo/shared/planMode'
import {
  formatConversationSummary,
  formatOwnerDmTakeoverContext,
  TAKEOVER_SECTION_DIVIDER,
  formatTakeoverTokens,
  formatTakeoverWorkspace,
  isDefaultNewChatThread,
  isOwnerDmTakeoverCandidate
} from './takeoverContext.ts'
import {
  getPlanAcceptanceKey,
  resolvePlanAcceptanceMode,
  startPlanAcceptance
} from './planAcceptance.ts'
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

const execFileAsync = promisify(execFile)

function resolveSyncCoreBinary(): string {
  const binaryName = process.platform === 'win32' ? 'sync-core.exe' : 'sync-core'
  const osMap: Record<string, string> = { darwin: 'mac', linux: 'linux', win32: 'win' }
  const platformDir = `${osMap[process.platform] ?? process.platform}-${process.arch}`
  const candidates = [
    ...(typeof process.resourcesPath === 'string'
      ? [join(process.resourcesPath, 'bin', binaryName)]
      : []),
    resolve(process.cwd(), 'apps/desktop/resources/bin', platformDir, binaryName),
    resolve(process.cwd(), 'native/sync-core/target/release', binaryName),
    resolve(process.cwd(), 'native/sync-core/target/debug', binaryName)
  ]

  const thisDir = import.meta.dirname
  if (thisDir && !thisDir.includes('.asar')) {
    const projectRoot = findProjectRoot(thisDir)
    if (projectRoot) {
      candidates.push(join(projectRoot, 'apps/desktop/resources/bin', platformDir, binaryName))
      candidates.push(join(projectRoot, 'native/sync-core/target/release', binaryName))
      candidates.push(join(projectRoot, 'native/sync-core/target/debug', binaryName))
    }
  }

  const binary = candidates.find(isExecutable)
  if (!binary) {
    throw new Error(
      'sync-core binary is unavailable. Run pnpm run sync-core:build before using sync.'
    )
  }
  return binary
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findProjectRoot(startDir: string): string | undefined {
  let current = startDir
  for (let depth = 0; depth < 10; depth++) {
    try {
      accessSync(join(current, 'pnpm-workspace.yaml'), constants.R_OK)
      return current
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) return undefined
      current = parent
    }
  }
  return undefined
}

function parseSyncCoreOutput(
  stdout: string,
  syncDirFallback: string,
  recommendedSyncDir: string
): SyncStatus {
  const parsed = JSON.parse(stdout) as {
    state?: SyncStatus['state']
    sync_dir?: string
    device_id?: string
    device_count?: number
    pending_conflict_count?: number
    last_exported_at?: string
    last_imported_at?: string
    last_error?: string
  }
  return {
    state: parsed.state ?? 'not_initialized',
    syncDir: parsed.sync_dir ?? syncDirFallback,
    recommendedSyncDir,
    ...(parsed.device_id ? { deviceId: parsed.device_id } : {}),
    deviceCount: parsed.device_count ?? 0,
    pendingConflictCount: parsed.pending_conflict_count ?? 0,
    ...(parsed.last_exported_at ? { lastExportedAt: parsed.last_exported_at } : {}),
    ...(parsed.last_imported_at ? { lastImportedAt: parsed.last_imported_at } : {}),
    ...(parsed.last_error ? { lastError: parsed.last_error } : {})
  }
}

function resolveCognitiveMemoryStore(
  store: CognitiveMemoryStore | undefined
): CognitiveMemoryStore {
  return store ?? createInMemoryCognitiveMemoryStore()
}

function compactThingMentionSourcePreview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim()
  return compact.length > 240 ? `${compact.slice(0, 239)}…` : compact
}

export class YachiyoServer {
  private readonly storage: YachiyoStorage
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly listeners = new Set<(event: YachiyoServerEvent) => void>()
  private readonly planAcceptancesBySourceThreadId = new Map<
    string,
    { key: string; promise: Promise<ChatAccepted> }
  >()
  private readonly activeChannelGroupHistoryClears = new Set<string>()
  private readonly retiredGroupProbeThreadIdsByGroup = new Map<string, Set<string>>()
  private readonly auxiliaryGeneration: import('../../runtime/models/auxiliaryGeneration.ts').AuxiliaryGenerationService
  private readonly createModelRuntimeFn: () => ModelRuntime
  private readonly memoryService: MemoryService
  private readonly configDomain: YachiyoServerConfigDomain
  private readonly runDomain: YachiyoServerRunDomain
  private readonly sentinelManager: ThreadSentinelManager
  private readonly threadDomain: YachiyoServerThreadDomain
  private readonly browserSearchSession: BrowserSearchSession
  private readonly resolveThreadWorkspacePath: (threadId: string) => string
  private readonly ensureThreadWorkspacePath: (threadId: string) => Promise<string>
  private readonly loadSkillCatalog = createCachedSkillCatalogLoader({
    loadCatalog: async (workspacePaths) => buildSkillRegistry(await discoverSkills(workspacePaths))
  })
  private readonly searchService: SearchService
  private readonly webSearchServiceInstance: import('../../services/webSearch/webSearchService.ts').WebSearchService
  private readonly imageToTextServiceInstance: ImageToTextService
  private readonly readUserDocumentFile: () => Promise<UserDocument | null>
  private readonly saveUserDocumentFile: (content: string) => Promise<UserDocument | null>
  private readonly readMemoryTermDocumentFile:
    | ((
        input?: Pick<GetMemoryTermDocumentInput, 'limit' | 'offset'>
      ) => Promise<MemoryTermDocument>)
    | null
  private readonly deleteMemoryTermFile:
    | ((input: DeleteMemoryTermInput) => Promise<DeleteMemoryTermResult>)
    | null
  private readonly readSoulDocumentFile: () => Promise<SoulDocument | null>
  private readonly addSoulTraitFile: (trait: string) => Promise<SoulDocument | null>
  private readonly removeSoulTraitFile: (trait: string) => Promise<SoulDocument | null>
  private readonly folderDomain: FolderDomain
  private readonly scheduleDomain: ScheduleDomain
  private readonly thingDomain: ThingDomain
  private readonly ttlReaper: TtlReaper
  private readonly jotdownStore: JotdownStore | null
  private readonly developmentMode: boolean
  private readonly remoteImageDomain: ReturnType<typeof createRemoteImageDomain>
  private readonly settingsPath: string
  // Serializes every sync that spawns the binary (manual, auto, init) so two
  // export/import passes never run against the same files at once.
  private syncMutex: Promise<unknown> = Promise.resolve()

  constructor(options: YachiyoServerOptions) {
    this.storage = options.storage
    this.developmentMode = options.developmentMode === true
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID

    this.settingsPath = options.settingsPath ?? resolveYachiyoSettingsPath()
    const settingsStore = createSettingsStore(this.settingsPath, {
      seedPresetProviders: options.seedPresetProviders
    })
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
    this.deleteMemoryTermFile =
      options.deleteMemoryTerm ??
      (options.cognitiveMemoryStore
        ? (input) => options.cognitiveMemoryStore!.deleteRow(input)
        : null)
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
      pageFactory: options.browserSearchPageFactory ?? unavailableBrowserSearchPageFactory,
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
        createDuckDuckGoBrowserWebSearchProvider({
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
        cognitiveStore: resolveCognitiveMemoryStore(options.cognitiveMemoryStore),
        createModelRuntime,
        readConfig: () => this.configDomain.readConfig(),
        readSettings: () => this.configDomain.readSettings()
      })

    this.memoryService = memoryService
    this.resolveThreadWorkspacePath = resolveThreadWorkspacePath
    this.ensureThreadWorkspacePath = ensureThreadWorkspace
    this.searchService = searchService
    this.webSearchServiceInstance = webSearchService
    this.jotdownStore = options.jotdownStore ?? null
    this.thingDomain = new ThingDomain({
      storage: this.storage,
      now: this.now,
      onThingsChanged: (things) => this.emit<ThingsUpdatedEvent>({ type: 'things.updated', things })
    })

    this.sentinelManager = createThreadSentinelManager({
      now: () => this.now().getTime(),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      emit: this.emit.bind(this),
      wakeThread: async ({ threadId, content, wakeContext }) => {
        await this.sendChat({
          threadId,
          content,
          toolPreset: wakeContext?.enabledTools,
          enabledSkillNames: wakeContext?.enabledSkillNames,
          runMode: wakeContext?.runMode,
          reasoningEffort: wakeContext?.reasoningEffort,
          runTrigger: wakeContext?.runTrigger ?? 'local',
          channelHint: wakeContext?.channelHint,
          extraTools: wakeContext?.extraTools
        })
      }
    })
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
      ...(options.browserAutomationService
        ? { browserAutomationService: options.browserAutomationService }
        : {}),
      ...(options.activityTracker ? { activityTracker: options.activityTracker } : {}),
      memoryService,
      sourceQueryExecutor: options.sourceQueryExecutor,
      thingDomain: this.thingDomain,
      readSoulDocument: this.readSoulDocumentFile,
      readUserDocument: this.readUserDocumentFile,
      readConfig: () => this.configDomain.readConfig(),
      readSettings: () => this.configDomain.readSettings(),
      runInactivityTimeoutMs: options.runInactivityTimeoutMs ?? 45_000,
      listSkills: (workspacePaths) => this.listSkills({ workspacePaths }),
      requireThread: this.requireThread.bind(this),
      loadThreadMessages: (threadId, options) => this.storage.listThreadMessages(threadId, options),
      loadThreadToolCalls: (threadId) => this.storage.listThreadToolCalls(threadId),
      jotdownStore: this.jotdownStore ?? undefined,
      imageToTextService: this.imageToTextServiceInstance,
      sentinelManager: this.sentinelManager
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
      loadThreadToolCalls: (threadId) => this.storage.listThreadToolCalls(threadId),
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
    this.sentinelManager.dispose()
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
      sentinelManager: this.sentinelManager,
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

  /**
   * Cheap, spawn-free check of whether sync can run on this device. Used both by
   * status reporting and to gate background auto-sync so it never spawns the
   * binary for a device that hasn't opted into sync.
   */
  private resolveSyncReadiness(): {
    syncDir: string
    recommendedSyncDir: string
    available: boolean
    initialized: boolean
  } {
    return resolveHostSyncReadiness(this.configDomain.readConfig())
  }

  async getSyncStatus(): Promise<SyncStatus> {
    const { syncDir, recommendedSyncDir, available, initialized } = this.resolveSyncReadiness()
    if (!available) {
      return {
        state: 'sync_dir_unavailable',
        syncDir,
        recommendedSyncDir,
        deviceCount: 0,
        pendingConflictCount: this.storage.countPendingSyncConflicts()
      }
    }
    if (!initialized) {
      return {
        state: 'not_initialized',
        syncDir,
        recommendedSyncDir,
        deviceCount: 0,
        pendingConflictCount: this.storage.countPendingSyncConflicts()
      }
    }
    try {
      const { stdout } = await execFileAsync(resolveSyncCoreBinary(), [
        'status',
        '--home',
        dirname(this.settingsPath),
        '--sync-dir',
        syncDir
      ])
      return parseSyncCoreOutput(stdout, syncDir, recommendedSyncDir)
    } catch (reason) {
      return {
        state: 'needs_attention',
        syncDir,
        recommendedSyncDir,
        deviceCount: 0,
        pendingConflictCount: this.storage.countPendingSyncConflicts(),
        lastError: reason instanceof Error ? reason.message : 'Failed to read sync status.'
      }
    }
  }

  async initSync(): Promise<SyncStatus> {
    const binary = resolveSyncCoreBinary()
    const home = dirname(this.settingsPath)
    const { syncDir } = this.resolveSyncReadiness()
    return this.runExclusiveSync(async () => {
      await execFileAsync(binary, [
        'init',
        '--home',
        home,
        '--sync-dir',
        syncDir,
        '--device-label',
        'Yachiyo'
      ])
      // Publish + pull once so enabling sync immediately produces a usable state.
      return this.exportThenImport(binary, home, syncDir)
    })
  }

  async runSyncNow(): Promise<SyncStatus> {
    const { syncDir } = this.resolveSyncReadiness()
    return this.runExclusiveSync(() =>
      this.exportThenImport(resolveSyncCoreBinary(), dirname(this.settingsPath), syncDir)
    )
  }

  /**
   * One automatic sync pass for the background scheduler. Skips (returns null)
   * when this device hasn't joined sync or iCloud is unavailable, and is
   * serialized with manual syncs through the same mutex.
   */
  async runAutoSyncCycle(): Promise<SyncStatus | null> {
    // universe.json can exist on a device that copied it from iCloud but hasn't
    // joined yet (no local device row). Exporting there fails every cycle with
    // "device is not initialized", so only run once this device is actually
    // joined — `deviceId` is set only when a local device row exists. getSyncStatus
    // still short-circuits without spawning the binary when iCloud is unavailable
    // or the universe is missing.
    const status = await this.getSyncStatus()
    if (!status.deviceId) return null
    return this.runExclusiveSync(() =>
      this.exportThenImport(resolveSyncCoreBinary(), dirname(this.settingsPath), status.syncDir)
    )
  }

  private runExclusiveSync<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.syncMutex.then(operation, operation)
    // Keep the chain alive regardless of this run's outcome.
    this.syncMutex = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async exportThenImport(
    binary: string,
    home: string,
    syncDir: string
  ): Promise<SyncStatus> {
    const recommendedSyncDir = resolveRecommendedICloudSyncDir()
    await execFileAsync(binary, ['export', '--home', home, '--sync-dir', syncDir])
    const { stdout } = await execFileAsync(binary, [
      'import',
      '--home',
      home,
      '--sync-dir',
      syncDir
    ])
    const status = parseSyncCoreOutput(stdout, syncDir, recommendedSyncDir)
    this.reconcileSyncConflicts()
    // The binary's own count predates reconciliation; report the live count.
    return { ...status, pendingConflictCount: this.storage.countPendingSyncConflicts() }
  }

  /**
   * Auto-handle conflicts the user shouldn't have to see again: drop ones whose
   * sides already match, and silently re-apply a remembered choice for a conflict
   * the user resolved before. Only genuinely-new differences are left pending.
   */
  private reconcileSyncConflicts(): void {
    for (const conflict of this.storage.listSyncConflicts()) {
      const remembered = this.storage.findRememberedSettingsResolution({
        entityType: conflict.entityType,
        localHash: conflict.localHash,
        remoteHash: conflict.remoteHash
      })
      const decision = decideSettingsConflict(conflict, remembered)
      if (decision === 'prompt') continue
      if (decision === 'apply-remote') {
        const remote = this.parseConflictRemoteSettings(conflict)
        if (remote) {
          this.configDomain.saveConfig(remote)
          // We now sit on the remote version; move sync-core's baseline with us.
          this.storage.rememberSyncSettingsBaseHash(conflict.remoteHash)
        }
      }
      // Drop the duplicate; the user's original resolved row stays as the memory.
      this.storage.deleteSyncConflict(conflict.id)
    }
  }

  async listSyncConflicts(): Promise<ListSyncConflictsResult> {
    return {
      conflicts: this.storage
        .listSyncConflicts()
        .map((conflict) => this.withSettingsFields(conflict))
    }
  }

  private withSettingsFields(conflict: SyncConflictRecord): SyncConflictRecord {
    if (conflict.entityType !== 'settings') return conflict
    const remote = this.parseConflictRemoteSettings(conflict)
    if (!remote) return conflict
    return { ...conflict, settingsFields: diffSettings(this.configDomain.getConfig(), remote) }
  }

  private parseConflictRemoteSettings(conflict: SyncConflictRecord): SettingsConfig | null {
    try {
      const payload = JSON.parse(conflict.payloadJson) as { text?: unknown }
      if (typeof payload.text !== 'string') return null
      const remote = normalizeSettingsConfig(parseSettingsToml(payload.text))
      return normalizeSettingsConfig({
        ...remote,
        sync: this.configDomain.getConfig().sync
      })
    } catch {
      return null
    }
  }

  async resolveSyncConflict(input: ResolveSyncConflictInput): Promise<ListSyncConflictsResult> {
    const conflict = this.storage.listSyncConflicts().find((item) => item.id === input.conflictId)
    if (!conflict) {
      return this.listSyncConflicts()
    }

    if (input.resolution === 'use_remote' || input.resolution === 'merge') {
      const remote = this.parseConflictRemoteSettings(conflict)
      if (!remote) {
        throw new Error('Synced settings payload is invalid.')
      }
      const nextConfig =
        input.resolution === 'merge'
          ? normalizeSettingsConfig(
              mergeSettings(this.configDomain.getConfig(), remote, input.fieldSelections ?? {})
            )
          : remote
      this.configDomain.saveConfig(nextConfig)
      // Adopting the synced version wholesale makes it our new baseline, so a later
      // local edit doesn't re-conflict peers already on it. A merge produces content
      // neither side has, so it can't reuse remoteHash and is left to re-sync normally.
      if (input.resolution === 'use_remote') {
        this.storage.rememberSyncSettingsBaseHash(conflict.remoteHash)
      }
    }

    this.storage.resolveSyncConflict({
      conflictId: input.conflictId,
      resolution: input.resolution,
      resolvedAt: this.now().toISOString()
    })
    return this.listSyncConflicts()
  }

  async saveUserDocument(input: { content: string }): Promise<UserDocument> {
    const document = await this.saveUserDocumentFile(input.content)
    if (!document) {
      throw new Error('Failed to save USER.md.')
    }

    return document
  }

  async getMemoryTermDocument(input?: GetMemoryTermDocumentInput): Promise<MemoryTermDocument> {
    if (!this.readMemoryTermDocumentFile) {
      throw new Error('Memory terms are unavailable.')
    }

    const limit =
      typeof input?.limit === 'number' && Number.isFinite(input.limit)
        ? Math.min(Math.max(Math.floor(input.limit), 1), 200)
        : undefined
    const offset =
      typeof input?.offset === 'number' && Number.isFinite(input.offset)
        ? Math.max(Math.floor(input.offset), 0)
        : 0

    return this.readMemoryTermDocumentFile({ limit, offset })
  }

  async deleteMemoryTerm(input: DeleteMemoryTermInput): Promise<DeleteMemoryTermResult> {
    if (!this.deleteMemoryTermFile) {
      throw new Error('Memory terms are unavailable.')
    }

    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!id) {
      throw new Error('Memory term id is required.')
    }

    return this.deleteMemoryTermFile({ id })
  }

  listActivitySourceRecords(
    input?: ListActivitySourceRecordsInput
  ): ListActivitySourceRecordsResult {
    const limit =
      typeof input?.limit === 'number' && Number.isFinite(input.limit)
        ? Math.min(Math.max(Math.floor(input.limit), 1), 200)
        : 50
    const offset =
      typeof input?.offset === 'number' && Number.isFinite(input.offset)
        ? Math.max(Math.floor(input.offset), 0)
        : 0
    return {
      records: this.storage.listActivitySourceRecords({ limit, offset }),
      totalCount: this.storage.countActivitySourceRecords(),
      limit,
      offset
    }
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
    return this.loadSkillCatalog(input.workspacePaths ?? [])
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

  searchThreadsAndMessages(input: SearchThreadsAndMessagesInput): ThreadSearchResult[] {
    return this.storage.searchThreadsAndMessages(input)
  }

  async listThings(input: { includeInactive?: boolean } = {}): Promise<ThingRecord[]> {
    return this.thingDomain.listThings(input)
  }
  async getThing(input: { name: string }): Promise<ThingRecord | undefined> {
    return this.thingDomain.getThing(input.name)
  }
  async restoreThing(input: { name: string }): Promise<ThingRecord | undefined> {
    return this.thingDomain.restoreThing(input.name)
  }
  async renameThing(input: RenameThingInput): Promise<ThingRecord | undefined> {
    return this.thingDomain.renameThing(input)
  }
  async deleteThing(input: { name: string }): Promise<boolean> {
    return this.thingDomain.deleteThing(input.name)
  }
  async removeThingSource(input: RemoveThingSourceInput): Promise<boolean> {
    return this.thingDomain.removeSource(input)
  }
  async continueThingInNewChat(input: { name: string }): Promise<ThreadRecord> {
    let thing = await this.thingDomain.getThing(input.name)
    if (!thing) throw new Error(`Thing is not available: #${input.name}`)
    if (thing.isInactive) thing = await this.thingDomain.restoreThing(input.name)
    if (!thing) throw new Error(`Thing is not available: #${input.name}`)
    const latestSource = thing.sources.at(0)
    const sourceThread = latestSource ? this.storage.getThread(latestSource.threadId) : undefined
    return this.createThread({
      ...(sourceThread?.workspacePath ? { workspacePath: sourceThread.workspacePath } : {}),
      ...(sourceThread?.modelOverride ? { modelOverride: sourceThread.modelOverride } : {})
    })
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
      modelOverride?: ThreadModelOverride
      reasoningEffort?: ComposerReasoningSelection
    } = {}
  ): Promise<ThreadRecord> {
    return createThreadWithHandoffWorkspace({
      createId: this.createId,
      payload: input,
      requireThread: this.requireThread.bind(this),
      ensureThreadWorkspace: this.ensureThreadWorkspacePath,
      threadDomain: this.threadDomain
    })
  }

  async compactThreadToAnotherThread(input: CompactThreadInput): Promise<CompactThreadAccepted> {
    return compactThreadWithHandoff({
      createId: this.createId,
      folderDomain: this.folderDomain,
      payload: input,
      requireThread: this.requireThread.bind(this),
      ensureThreadWorkspace: this.ensureThreadWorkspacePath,
      runDomain: this.runDomain,
      threadDomain: this.threadDomain
    })
  }

  async compactChannelThreadForChannelUser(input: {
    threadId: string
    channelUser: ChannelUserRecord
  }): Promise<CompactThreadAccepted> {
    if (input.channelUser.role !== 'owner') {
      throw new Error('Only owner DMs can start a handoff.')
    }

    const sourceThread = this.requireThread(input.threadId)
    this.assertWritableThreadRecord(sourceThread)
    if (
      sourceThread.channelUserId !== input.channelUser.id ||
      sourceThread.channelUserRole !== 'owner'
    ) {
      throw new Error('This conversation does not belong to this owner DM.')
    }
    if (
      sourceThread.source &&
      sourceThread.source !== 'local' &&
      sourceThread.source !== input.channelUser.platform
    ) {
      throw new Error('This conversation does not belong to this owner DM.')
    }
    if (this.runDomain.hasActiveThread(sourceThread.id)) {
      throw new Error('Cannot start a handoff while this conversation is running.')
    }

    const destinationThread = await this.threadDomain.createThread({
      threadId: this.createId(),
      ...(sourceThread.source ? { source: sourceThread.source } : {}),
      channelUserId: input.channelUser.id,
      handoffFromThreadId: sourceThread.id,
      workspacePath: sourceThread.workspacePath?.trim()
        ? sourceThread.workspacePath
        : await this.ensureThreadWorkspacePath(sourceThread.id),
      ...(sourceThread.modelOverride ? { modelOverride: sourceThread.modelOverride } : {}),
      ...(sourceThread.reasoningEffort ? { reasoningEffort: sourceThread.reasoningEffort } : {}),
      ...(sourceThread.runMode ? { runMode: sourceThread.runMode } : {})
    })

    this.folderDomain.ensureFolderForDerivedThread({
      sourceThread,
      derivedThread: destinationThread
    })

    return this.runDomain.compactThreadToAnotherThread({
      sourceThread,
      destinationThread,
      reasoningEffort: destinationThread.reasoningEffort
    })
  }

  async updateThreadWorkspace(input: ThreadWorkspaceUpdateInput): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.updateWorkspace(input)
  }

  getThreadWorkspaceChangeDecision(
    input: ThreadWorkspaceChangeDecisionInput
  ): ThreadWorkspaceChangeDecision {
    return this.threadDomain.getWorkspaceChangeDecision(input)
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

  async readThreadPlanDocument(
    input: ReadThreadPlanDocumentInput
  ): Promise<ReadThreadPlanDocumentResult> {
    const thread = this.requireThread(input.threadId)
    const workspacePath = thread.workspacePath?.trim()
      ? resolve(thread.workspacePath)
      : await this.ensureThreadWorkspacePath(thread.id)

    const planDir = join(workspacePath, PLAN_DOCUMENT_DIR_NAME)
    const filename = getThreadPlanDocumentFilename(thread.id)
    const path = join(planDir, filename)
    const content = await readFile(path, 'utf8')

    const stateFilename = getThreadPlanDocumentStateFilename(thread.id)
    const statePath = join(planDir, stateFilename)
    const decision = await readFile(statePath, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw) as ThreadPlanDocumentStateFile
        if (parsed?.decision !== 'accepted') return undefined
        if (typeof parsed.planContentHash !== 'string') return undefined
        const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')
        if (contentHash !== parsed.planContentHash) return undefined
        return 'accepted' as const
      })
      .catch(() => undefined)

    return { path, content, ...(decision ? { decision } : {}) }
  }

  async acceptThreadPlanDocument(input: AcceptThreadPlanDocumentInput): Promise<ChatAccepted> {
    const sourceThread = this.requireThread(input.threadId)
    this.assertWritableThreadRecord(sourceThread)

    if (sourceThread.source && sourceThread.source !== 'local') {
      throw new Error('Plan acceptance is only supported for local threads.')
    }

    if (this.runDomain.hasActiveThread(sourceThread.id)) {
      throw new Error('Cannot accept a plan while the source thread has an active run.')
    }

    const mode = resolvePlanAcceptanceMode(input.mode)
    const plan = await this.readThreadPlanDocument({ threadId: sourceThread.id })
    const key = getPlanAcceptanceKey(plan, mode)
    const existingAcceptance = this.planAcceptancesBySourceThreadId.get(sourceThread.id)
    if (existingAcceptance?.key === key) {
      return existingAcceptance.promise
    }

    const promise = startPlanAcceptance({
      createId: () => this.createId(),
      emit: (event) => this.emit(event),
      folderDomain: this.folderDomain,
      mode,
      plan,
      resolveThreadWorkspacePath: this.resolveThreadWorkspacePath,
      runDomain: this.runDomain,
      sourceThread,
      storage: this.storage,
      threadDomain: this.threadDomain,
      timestamp: () => this.timestamp()
    }).then(async (accepted) => {
      const planDir = dirname(plan.path)
      const statePath = join(planDir, getThreadPlanDocumentStateFilename(sourceThread.id))
      const planContentHash = createHash('sha256').update(plan.content, 'utf8').digest('hex')
      const state: ThreadPlanDocumentStateFile = {
        decision: 'accepted',
        acceptedAt: this.timestamp(),
        acceptedMode: mode,
        acceptedThreadId: accepted.thread.id,
        planContentHash
      }
      await writeFile(statePath, JSON.stringify(state), 'utf8').catch(() => undefined)
      return accepted
    })
    this.planAcceptancesBySourceThreadId.set(sourceThread.id, { key, promise })

    try {
      return await promise
    } catch (error) {
      if (this.planAcceptancesBySourceThreadId.get(sourceThread.id)?.promise === promise) {
        this.planAcceptancesBySourceThreadId.delete(sourceThread.id)
      }
      throw error
    }
  }

  async createFolderForThreads(input: { threadIds: string[] }): Promise<FolderRecord> {
    const threads = input.threadIds.map((id) => this.requireThread(id))
    for (const thread of threads) {
      this.assertWritableThreadRecord(thread)
    }
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
    this.assertWritableThread(input.threadId)
    return this.folderDomain.moveThreadToFolder(input)
  }

  async renameThread(input: { threadId: string; title: string }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.renameThread(input)
  }

  async setThreadColor(input: {
    threadId: string
    colorTag: ThreadColorTag | null
  }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.setThreadColor(input)
  }

  async setThreadIcon(input: { threadId: string; icon: string | null }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.setThreadIcon(input)
  }

  async starThread(input: { threadId: string; starred: boolean }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.starThread(input)
  }

  async regenerateThreadTitle(input: { threadId: string }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.regenerateThreadTitle(input)
  }

  async setThreadPrivacyMode(input: { threadId: string; enabled: boolean }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.setThreadPrivacyMode(input)
  }

  async setThreadModelOverride(input: {
    threadId: string
    modelOverride: ThreadModelOverride | null
  }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.setThreadModelOverride(input)
  }

  async setThreadToolMode(input: {
    threadId: string
    enabledTools: ToolCallName[]
    runMode?: RunModeId
  }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.setThreadToolMode(input)
  }

  async setThreadReasoningEffort(input: {
    threadId: string
    reasoningEffort: ComposerReasoningSelection | null
  }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.setThreadReasoningEffort(input)
  }

  async setThreadRuntimeBinding(input: {
    threadId: string
    runtimeBinding: ThreadRuntimeBinding | null
  }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.setThreadRuntimeBinding(input)
  }

  async archiveThread(input: { threadId: string; unread?: boolean }): Promise<void> {
    this.assertWritableThread(input.threadId)
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

  /** Marks run snapshots as emptied after a checkpoint restore destroyed them. */
  clearRunSnapshotFileCounts(input: { runIds: string[] }): void {
    for (const runId of input.runIds) {
      this.storage.updateRunSnapshot(runId, { fileCount: 0 })
    }
  }

  async restoreThread(input: { threadId: string }): Promise<ThreadRecord> {
    this.assertWritableAnyThread(input.threadId)
    return this.threadDomain.restoreThread(input)
  }

  async deleteThread(input: { threadId: string }): Promise<void> {
    this.assertWritableAnyThread(input.threadId)
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

  async sendChat(input: InternalSendChatInput): Promise<ChatAccepted> {
    this.assertWritableThread(input.threadId)
    const accepted = await this.runDomain.sendChat(input)
    await this.addThingMentionSources(accepted)
    return accepted
  }

  async retryMessage(input: RetryInput): Promise<RetryAccepted> {
    this.assertWritableThread(input.threadId)
    return this.runDomain.retryMessage(input)
  }

  async saveThread(input: SaveThreadInput): Promise<SaveThreadResult> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.saveThread(input)
  }

  async selectReplyBranch(input: {
    threadId: string
    assistantMessageId: string
  }): Promise<ThreadRecord> {
    this.assertWritableThread(input.threadId)
    return this.threadDomain.selectReplyBranch(input)
  }

  async createBranch(input: {
    threadId: string
    messageId: string
    truncateBeforeToolCallId?: string
  }): Promise<ThreadSnapshot> {
    const sourceThread = this.requireThread(input.threadId)
    this.assertWritableThreadRecord(sourceThread)
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
    this.assertWritableThread(input.threadId)
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
    this.assertWritableThreadRecord(thread)
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
      enabledSkillNames: input.enabledSkillNames,
      runMode: input.runMode,
      reasoningEffort: input.reasoningEffort
    })
    await this.addThingMentionSources(accepted)
    if ('userMessage' in accepted) {
      return { ...accepted, replacedMessageId: input.messageId }
    }
    return accepted
  }

  private async addThingMentionSources(accepted: ChatAccepted): Promise<void> {
    if (!('userMessage' in accepted)) return

    const slugs = collectThingMentionSlugs(accepted.userMessage.content)
    if (slugs.length === 0) return

    const sourceRowId = messageRowId(accepted.thread.id, accepted.userMessage.id)
    const preview = compactThingMentionSourcePreview(accepted.userMessage.content)

    for (const slug of slugs) {
      const resolution = await this.thingDomain.resolveThingMention(slug)
      if (!resolution.resolved) continue
      await this.thingDomain.upsertSource({
        name: resolution.name,
        threadId: accepted.thread.id,
        messageId: accepted.userMessage.id,
        sourceRowId,
        preview
      })
    }
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
  ): Promise<import('@yachiyo/shared/protocol').BackgroundTaskSnapshot[]> {
    return hydrateBackgroundTaskSnapshots(this.runDomain.listBackgroundTasks(input.threadId))
  }

  async getBackgroundTaskLog(input: {
    threadId: string
    taskId: string
    maxBytes?: number
  }): Promise<import('@yachiyo/shared/protocol').BackgroundTaskLogSnapshot> {
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

  loadThreadData(
    threadId: string,
    options: { includeMessages?: boolean } = {}
  ): {
    messages: MessageRecord[]
    queuedFollowUpMessages: MessageRecord[]
    toolCalls: ToolCallRecord[]
    runs: RunRecord[]
    scheduleRun?: ScheduleRunRecord
  } {
    const includeMessages = options.includeMessages !== false
    const scheduleRun = this.storage.getScheduleRunByThreadId(threadId)
    const messages = includeMessages ? this.storage.listThreadMessages(threadId) : []
    const toolCalls = includeMessages ? this.storage.listThreadToolCalls(threadId) : []
    const thread = this.storage.getThread(threadId)
    const snapshot = thread
      ? this.runDomain.withQueuedFollowUpDraftSnapshot({ thread, messages, toolCalls })
      : { messages, queuedFollowUpMessages: [], toolCalls }

    return {
      messages: snapshot.messages,
      queuedFollowUpMessages: snapshot.queuedFollowUpMessages ?? [],
      toolCalls: snapshot.toolCalls,
      runs: this.storage.listThreadRuns(threadId),
      ...(scheduleRun ? { scheduleRun } : {})
    }
  }

  listExternalThreads(): ThreadRecord[] {
    return this.storage.listExternalThreads()
  }

  listOwnerDmTakeoverThreads(input: { channelUserId: string; limit: number }): ThreadRecord[] {
    return this.storage
      .listOwnerDmTakeoverThreadCandidates()
      .filter(
        (thread) =>
          isOwnerDmTakeoverCandidate(thread) &&
          (!isDefaultNewChatThread(thread) || this.storage.hasVisibleThreadMessages(thread.id))
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

  private assertWritableThread(threadId: string): void {
    this.assertWritableThreadRecord(this.requireThread(threadId))
  }

  private assertWritableAnyThread(threadId: string): void {
    const thread = this.storage.getThread(threadId) ?? this.storage.getArchivedThread(threadId)
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`)
    }
    this.assertWritableThreadRecord(thread)
  }

  private assertWritableThreadRecord(thread: ThreadRecord): void {
    if (thread.syncOriginDeviceId) {
      throw new Error('Synced archive threads are read-only on this device.')
    }
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
