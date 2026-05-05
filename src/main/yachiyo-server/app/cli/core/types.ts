import type {
  ChannelGroupStatus,
  ProviderConfig,
  SettingsConfig
} from '../../../../../shared/yachiyo/protocol.ts'
import type {
  readSoulDocument as defaultReadSoulDocument,
  upsertDailySoulTrait as defaultUpsertDailySoulTrait,
  removeSoulTrait as defaultRemoveSoulTrait,
  SoulDocument,
  RemoveSoulTraitInput,
  UpsertDailySoulTraitInput
} from '../../../runtime/soul.ts'
import type { MessageSearchHit, ThreadSummary, ThreadDump } from '../services/threadSearch.ts'
import type { YachiyoStorage } from '../../../storage/storage.ts'

export type CliStdout = Pick<typeof process.stdout, 'write'>
export type CliStderr = Pick<typeof process.stderr, 'write'>

export interface CliConfigService {
  getConfig(): SettingsConfig | Promise<SettingsConfig>
  saveConfig(input: SettingsConfig): SettingsConfig | Promise<SettingsConfig>
  upsertProvider(input: ProviderConfig): ProviderConfig | Promise<ProviderConfig>
  setDefaultProvider(input: {
    id?: string
    name?: string
    model?: string
  }): SettingsConfig | Promise<SettingsConfig>
  fetchProviderModels(input: ProviderConfig): Promise<string[]>
}

export interface RunYachiyoCliOptions {
  createConfigService?: (settingsPath: string) => CliConfigService
  createStorage?: (dbPath: string) => YachiyoStorage
  readSoulDocument?: typeof defaultReadSoulDocument
  upsertDailySoulTrait?: typeof defaultUpsertDailySoulTrait
  removeSoulTrait?: typeof defaultRemoveSoulTrait
  searchMessages?: (
    dbPath: string,
    query: string,
    limit: number,
    includePrivate: boolean
  ) => MessageSearchHit[]
  listRecentThreads?: (dbPath: string, limit: number, includePrivate: boolean) => ThreadSummary[]
  dumpThread?: (dbPath: string, threadId: string, includePrivate: boolean) => ThreadDump | null
  sendNotification?: (
    socketPath: string,
    payload: { title: string; body?: string }
  ) => Promise<void>
  sendChannel?: (
    socketPath: string,
    payload: { type: 'send-channel'; id: string; message: string }
  ) => Promise<void>
  sendChannelGroupStatus?: (
    socketPath: string,
    payload: {
      type: 'update-channel-group-status'
      id: string
      status: ChannelGroupStatus
    }
  ) => Promise<void>
  sendChannelGroupLabel?: (
    socketPath: string,
    payload: {
      type: 'update-channel-group-label'
      id: string
      label: string
    }
  ) => Promise<void>
  sendMarkThreadReviewed?: (
    socketPath: string,
    payload: { type: 'mark-thread-reviewed'; threadId: string }
  ) => Promise<void>
  stdout?: CliStdout
  stderr?: CliStderr
}

export type { SoulDocument, RemoveSoulTraitInput, UpsertDailySoulTraitInput }
