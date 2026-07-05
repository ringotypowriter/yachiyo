import type {
  ComposerReasoningSelection,
  MessageFileAttachment,
  MessageRecord,
  ProviderSettings,
  RunModeId,
  SendChatInput,
  SendChatRunTrigger,
  SkillCatalogEntry,
  SettingsConfig,
  ThreadRecord,
  ToolCallName,
  ToolCallRecord
} from '@yachiyo/shared/protocol'
import type { AuxiliaryGenerationService } from '../../../runtime/models/auxiliaryGeneration.ts'
import type { BrowserWebPageSnapshotLoader } from '../../../services/webRead/browserWebPageSnapshot.ts'
import type { JotdownStore } from '../../../services/jotdownStore.ts'
import type { MemoryService } from '../../../services/memory/memoryService.ts'
import type { ActivitySummarySource } from '../../../activity/ActivityTracker.ts'
import type { BrowserAutomationToolBackend } from '../../../services/browserAutomation/browserAutomationToolBackend.ts'
import type { SearchService } from '../../../services/search/searchService.ts'
import type { WebSearchService } from '../../../services/webSearch/webSearchService.ts'
import type { ModelRuntime } from '../../../runtime/models/types.ts'
import type { SnapshotTracker } from '../../../services/fileSnapshot/snapshotTracker.ts'
import type {
  ListThreadMessagesOptions,
  RunRecoveryCheckpoint,
  YachiyoStorage
} from '../../../storage/storage.ts'
import type { QuerySourceExecutor } from '../../../tools/agentTools/querySourceTool.ts'
import type { ThreadSentinelManager } from '../sentinel/threadSentinelManager.ts'
import type { SoulDocument } from '../../../runtime/profiles/soul.ts'
import type { UserDocument } from '../../../runtime/profiles/user.ts'
import type { CreateId, EmitServerEvent, Timestamp } from '../shared/shared.ts'
import type { TodoProgressState } from './todo/todoProgress.ts'
import type { ThingDomain } from '../things/thingDomain.ts'

export type RunExecutionPhase = 'generating' | 'tool-running' | 'waiting-for-user' | 'terminal'

export type InternalSendChatInput = SendChatInput & {
  /** Internal per-run tool preset for system/channel runs that need a fixed tool set. */
  toolPreset?: ToolCallName[]
}

export const CONTEXT_HANDOFF_CONTINUATION_STEER =
  'Context was checkpointed; continue the same task from the handoff summary without repeating completed tool calls.'

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
  pendingContextHandoff?: {
    reason: 'preflight' | 'step-boundary' | 'context-window-error' | string
    requestedAtStep?: number
  }
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
  thingDomain?: ThingDomain
  searchService?: SearchService
  webSearchService?: WebSearchService
  browserAutomationService?: BrowserAutomationToolBackend
  activityTracker?: ActivitySummarySource
  readSoulDocument?: () => Promise<SoulDocument | null>
  readUserDocument?: () => Promise<UserDocument | null>
  readConfig: () => SettingsConfig
  readSettings: () => ProviderSettings
  listSkills: (workspacePaths?: string[]) => Promise<SkillCatalogEntry[]>
  requireThread: (threadId: string) => ThreadRecord
  loadThreadMessages: (threadId: string, options?: ListThreadMessagesOptions) => MessageRecord[]
  loadThreadToolCalls: (threadId: string) => ToolCallRecord[]
  jotdownStore?: JotdownStore
  imageToTextService?: import('../../../services/imageToText/imageToTextService.ts').ImageToTextService
  sentinelManager?: ThreadSentinelManager
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
