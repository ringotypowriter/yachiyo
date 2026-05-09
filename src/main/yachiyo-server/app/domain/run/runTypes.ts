import type {
  ComposerReasoningSelection,
  MessageFileAttachment,
  MessageRecord,
  ProviderSettings,
  SendChatRunTrigger,
  SkillCatalogEntry,
  SettingsConfig,
  ThreadRecord,
  ToolCallName,
  ToolCallRecord
} from '../../../../../shared/yachiyo/protocol.ts'
import type { AuxiliaryGenerationService } from '../../../runtime/models/auxiliaryGeneration.ts'
import type { BrowserWebPageSnapshotLoader } from '../../../services/webRead/browserWebPageSnapshot.ts'
import type { JotdownStore } from '../../../services/jotdownStore.ts'
import type { MemoryService } from '../../../services/memory/memoryService.ts'
import type { SearchService } from '../../../services/search/searchService.ts'
import type { WebSearchService } from '../../../services/webSearch/webSearchService.ts'
import type { ModelRuntime } from '../../../runtime/models/types.ts'
import type { RunRecoveryCheckpoint, YachiyoStorage } from '../../../storage/storage.ts'
import type { SoulDocument } from '../../../runtime/profiles/soul.ts'
import type { UserDocument } from '../../../runtime/profiles/user.ts'
import type { CreateId, EmitServerEvent, Timestamp } from '../shared/shared.ts'

export type RunExecutionPhase = 'generating' | 'tool-running' | 'waiting-for-user' | 'terminal'

export interface RunState {
  threadId: string
  requestMessageId?: string
  enabledSkillNames?: string[]
  reasoningEffort?: ComposerReasoningSelection
  runTrigger?: SendChatRunTrigger
  channelHint?: string
  recoveryCheckpoint?: RunRecoveryCheckpoint
  abortController: AbortController
  pendingSteerMessageId?: string
  pendingSteerInput?: {
    content: string
    images: MessageRecord['images']
    attachments: MessageFileAttachment[]
    messageId: string
    timestamp: string
    reasoningEffort?: ComposerReasoningSelection
    hidden?: boolean
    previousEnabledSkillNames?: string[]
    previousReasoningEffort?: ComposerReasoningSelection
    previousRunTrigger?: SendChatRunTrigger
  }
  executionPhase: RunExecutionPhase
  updateHeadOnComplete: boolean
  /** Resolves a pending askUser tool call with the user's answer. Set by execution. */
  answerToolQuestion?: (toolCallId: string, answer: string) => void
  /** When true, this run is an ephemeral recap — no messages persisted, result returned via recapResolve. */
  recap?: boolean
  recapResolve?: (text: string | null) => void
  recapUserMessage?: MessageRecord
}

export interface RunDomainDeps {
  storage: YachiyoStorage
  createId: CreateId
  timestamp: Timestamp
  emit: EmitServerEvent
  runInactivityTimeoutMs: number
  auxiliaryGeneration: AuxiliaryGenerationService
  createModelRuntime: () => ModelRuntime
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  fetchImpl?: typeof globalThis.fetch
  webExternalFetchImpl?: typeof globalThis.fetch
  loadBrowserSnapshot?: BrowserWebPageSnapshotLoader
  memoryService: MemoryService
  searchService?: SearchService
  webSearchService?: WebSearchService
  readSoulDocument?: () => Promise<SoulDocument | null>
  readUserDocument?: () => Promise<UserDocument | null>
  readConfig: () => SettingsConfig
  readSettings: () => ProviderSettings
  listSkills: (workspacePaths?: string[]) => Promise<SkillCatalogEntry[]>
  requireThread: (threadId: string) => ThreadRecord
  loadThreadMessages: (threadId: string) => MessageRecord[]
  loadThreadToolCalls: (threadId: string) => ToolCallRecord[]
  jotdownStore?: JotdownStore
  imageToTextService?: import('../../../services/imageToText/imageToTextService.ts').ImageToTextService
}

export interface BackgroundTaskRunContext {
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  reasoningEffort?: ComposerReasoningSelection
  runTrigger: SendChatRunTrigger
  channelHint?: string
  extraTools?: import('ai').ToolSet
}
