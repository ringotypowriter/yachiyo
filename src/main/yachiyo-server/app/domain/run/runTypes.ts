import type {
  ComposerReasoningSelection,
  MessageFileAttachment,
  MessageRecord,
  ProviderSettings,
  RunModeId,
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
import type { BrowserAutomationService } from '../../../services/browserAutomation/electronBrowserAutomationService.ts'
import type { SearchService } from '../../../services/search/searchService.ts'
import type { WebSearchService } from '../../../services/webSearch/webSearchService.ts'
import type { ModelRuntime } from '../../../runtime/models/types.ts'
import type { SnapshotTracker } from '../../../services/fileSnapshot/snapshotTracker.ts'
import type { RunRecoveryCheckpoint, YachiyoStorage } from '../../../storage/storage.ts'
import type { QuerySourceExecutor } from '../../../tools/agentTools/querySourceTool.ts'
import type { SoulDocument } from '../../../runtime/profiles/soul.ts'
import type { UserDocument } from '../../../runtime/profiles/user.ts'
import type { CreateId, EmitServerEvent, Timestamp } from '../shared/shared.ts'
import type { TodoProgressState } from './todo/todoProgress.ts'

export type RunExecutionPhase = 'generating' | 'tool-running' | 'waiting-for-user' | 'terminal'

export interface PendingSteerInput {
  content: string
  images: MessageRecord['images']
  attachments: MessageFileAttachment[]
  messageId: string
  timestamp: string
  enabledTools?: ToolCallName[]
  enabledSkillNames?: string[]
  runMode?: RunModeId
  reasoningEffort?: ComposerReasoningSelection
  runTrigger?: SendChatRunTrigger
  hidden?: boolean
  previousEnabledTools?: ToolCallName[]
  previousEnabledSkillNames?: string[]
  previousRunMode?: RunModeId
  previousReasoningEffort?: ComposerReasoningSelection
  previousRunTrigger?: SendChatRunTrigger
}

export interface RunState {
  threadId: string
  requestMessageId?: string
  enabledTools?: ToolCallName[]
  enabledSkillNames?: string[]
  runMode?: RunModeId
  reasoningEffort?: ComposerReasoningSelection
  runTrigger?: SendChatRunTrigger
  channelHint?: string
  recoveryCheckpoint?: RunRecoveryCheckpoint
  abortController: AbortController
  pendingSteerMessageId?: string
  pendingSteerInputs?: PendingSteerInput[]
  executionPhase: RunExecutionPhase
  snapshotTracker?: SnapshotTracker
  workspaceRestorePointMessageIds?: Set<string>
  updateHeadOnComplete: boolean
  /** Resolves a pending askUser tool call with the user's answer. Set by execution. */
  answerToolQuestion?: (toolCallId: string, answer: string) => void
  /** When true, this run is an ephemeral recap — no messages persisted, result returned via recapResolve. */
  recap?: boolean
  recapResolve?: (text: string | null) => void
  recapUserMessage?: MessageRecord
  agentStepCount?: number
  todoProgress?: TodoProgressState
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
  sourceQueryExecutor?: QuerySourceExecutor
  searchService?: SearchService
  webSearchService?: WebSearchService
  browserAutomationService?: BrowserAutomationService
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
  runMode: RunModeId
  enabledSkillNames?: string[]
  reasoningEffort?: ComposerReasoningSelection
  runTrigger: SendChatRunTrigger
  channelHint?: string
  extraTools?: import('ai').ToolSet
}
