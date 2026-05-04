import type {
  MemoryTermDocument,
  SettingsConfig,
  UserDocument
} from '../../../../shared/yachiyo/protocol.ts'
import type { ModelRuntime } from '../../runtime/types.ts'
import type { JotdownStore } from '../../services/jotdownStore.ts'
import type { MemoryProvider, MemoryService } from '../../services/memory/memoryService.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import type { RemoteImageFetcher } from '../domain/remoteImageDomain.ts'
import type { SoulDocument } from '../../runtime/soul.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'

export interface YachiyoServerOptions {
  storage: YachiyoStorage
  settingsPath?: string
  seedPresetProviders?: boolean
  developmentMode?: boolean
  fetchImpl?: typeof globalThis.fetch
  /** TLS-relaxed fetch for external web content (webRead direct path). Falls back to fetchImpl. */
  webExternalFetchImpl?: typeof globalThis.fetch
  runInactivityTimeoutMs?: number
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
  jotdownStore?: JotdownStore
  /** Optional override for the remote image downloader. Defaults to `fetchImpl`. */
  remoteImageFetcher?: RemoteImageFetcher
}

export interface SqliteYachiyoServerOptions extends Omit<YachiyoServerOptions, 'storage'> {
  dbPath: string
}
