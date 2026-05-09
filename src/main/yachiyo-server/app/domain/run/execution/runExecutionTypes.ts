import type { ToolSet } from 'ai'

import type {
  ComposerReasoningSelection,
  MessageRecord,
  ProviderSettings,
  RecallDecisionSnapshot,
  SettingsConfig,
  SkillCatalogEntry,
  SendChatRunTrigger,
  ThreadRecord,
  ToolCallName,
  ToolCallRecord
} from '../../../../../../shared/yachiyo/protocol.ts'
import type { ActivitySummary } from '../../../../activity/ActivityTracker.ts'
import type { ImageToTextService } from '../../../../services/imageToText/imageToTextService.ts'
import type { MemoryService } from '../../../../services/memory/memoryService.ts'
import type { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import type { BrowserWebPageSnapshotLoader } from '../../../../services/webRead/browserWebPageSnapshot.ts'
import type { SearchService } from '../../../../services/search/searchService.ts'
import type { WebSearchService } from '../../../../services/webSearch/webSearchService.ts'
import type { JotdownStore } from '../../../../services/jotdownStore.ts'
import type { ModelRuntime, ModelUsage } from '../../../../runtime/models/types.ts'
import type { SoulDocument } from '../../../../runtime/profiles/soul.ts'
import type { UserDocument } from '../../../../runtime/profiles/user.ts'
import type { RunRecoveryCheckpoint, YachiyoStorage } from '../../../../storage/storage.ts'
import type { RunExecutionPhase } from '../runTypes.ts'
import type {
  DelegateCodingTaskFinishedEvent,
  DelegateCodingTaskProgressEvent,
  DelegateCodingTaskStartedEvent,
  ReadRecordCache
} from '../../../../tools/agentTools.ts'
import type {
  BackgroundBashAdoptionHandle,
  BackgroundBashTaskHandle
} from '../../../../tools/agentTools/shared.ts'
import type { BackgroundBashTaskResult } from '../../background/backgroundBashManager.ts'
import type { CreateId, EmitServerEvent, Timestamp } from '../../shared/shared.ts'

export interface ExecuteRunInput {
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  reasoningEffort?: ComposerReasoningSelection
  runTrigger: SendChatRunTrigger
  channelHint?: string
  extraTools?: ToolSet
  inactivityTimeoutMs: number
  recoveryCheckpoint?: RunRecoveryCheckpoint
  runId: string
  thread: ThreadRecord
  requestMessageId: string
  abortController: AbortController
  updateHeadOnComplete: boolean
  previousEnabledTools: ToolCallName[] | null
  /** Accumulated usage from prior steer legs of the same run. */
  priorUsage?: Pick<
    ModelUsage,
    | 'promptTokens'
    | 'completionTokens'
    | 'totalPromptTokens'
    | 'totalCompletionTokens'
    | 'cacheReadTokens'
    | 'cacheWriteTokens'
  >
  /** True when this leg continues from a prior steer/restart within the same run. */
  isSteerLeg?: boolean
  /** Snapshot tracker carried over from a prior steer/restart leg. */
  snapshotTracker?: SnapshotTracker
  /** Override the computed max tool steps. */
  maxToolStepsOverride?: number
  /** Shared read-record cache, persisted across runs within the same thread. */
  readRecordCache?: ReadRecordCache
  /** Number of tool-fail loop steers already injected in prior legs of this run. */
  priorToolFailLoopSteers?: number
}

export interface RestartRunReason {
  type: 'restart'
  nextRequestMessageId: string
}

export interface CancelWithSteerReason {
  type: 'cancel-with-steer'
  steerInput: {
    content: string
    images: MessageRecord['images']
    attachments: NonNullable<MessageRecord['attachments']>
    messageId: string
    timestamp: string
    hidden?: boolean
  }
}

export type ExecuteRunResult =
  | { kind: 'completed'; totalPromptTokens?: number; usedRememberTool?: boolean }
  | { kind: 'failed'; usage?: ModelUsage }
  | { kind: 'cancelled'; usage?: ModelUsage }
  | {
      kind: 'restarted'
      nextRequestMessageId: string
      usage?: ModelUsage
      snapshotTracker?: SnapshotTracker
    }
  | {
      kind: 'steer-pending'
      assistantMessageId: string
      usage?: ModelUsage
      snapshotTracker?: SnapshotTracker
      toolFailLoopSteersInjected?: number
    }
  | {
      kind: 'cancelled-with-steer'
      stoppedMessageId: string
      steerInput: CancelWithSteerReason['steerInput']
      usage?: ModelUsage
    }
  | { kind: 'recovering'; checkpoint: RunRecoveryCheckpoint }

export interface RunExecutionDeps {
  storage: YachiyoStorage
  createId: CreateId
  timestamp: Timestamp
  emit: EmitServerEvent
  createModelRuntime: () => ModelRuntime
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  buildMemoryLayerEntries?: (input: {
    requestMessageId: string
    signal: AbortSignal
    thread: ThreadRecord
    userQuery: string
  }) => Promise<{
    entries: string[]
    recallDecision?: RecallDecisionSnapshot
  }>
  fetchImpl?: typeof globalThis.fetch
  webExternalFetchImpl?: typeof globalThis.fetch
  loadBrowserSnapshot?: BrowserWebPageSnapshotLoader
  memoryService: MemoryService
  searchService?: SearchService
  webSearchService?: WebSearchService
  readSoulDocument?: () => Promise<SoulDocument | null>
  readUserDocument?: () => Promise<UserDocument | null>
  readThread: (threadId: string) => ThreadRecord
  readConfig: () => SettingsConfig
  readSettings: () => ProviderSettings
  loadThreadMessages: (threadId: string) => MessageRecord[]
  loadThreadToolCalls: (threadId: string) => ToolCallRecord[]
  listSkills: (workspacePaths?: string[]) => Promise<SkillCatalogEntry[]>
  onEnabledToolsUsed: (enabledTools: ToolCallName[]) => void
  onExecutionPhaseChange?: (phase: RunExecutionPhase) => void
  hasPendingSteer?: () => boolean
  /** Called by execution to inject a system steer that breaks loops or redirects the model. */
  injectPendingSteer?: (input: { content: string }) => void
  /** Called by execution to register the askUser answer handler. */
  onAskUserHandlerReady?: (handler: (toolCallId: string, answer: string) => void) => void
  onTerminalState?: () => void
  onBackgroundBashStarted?: (task: BackgroundBashTaskHandle & { threadId: string }) => Promise<void>
  onBackgroundBashAdopted?: (
    task: BackgroundBashAdoptionHandle & { threadId: string }
  ) => Promise<void>
  getCompletedBackgroundBashTask?: (taskId: string) => BackgroundBashTaskResult | undefined
  onSubagentProgress?: (event: DelegateCodingTaskProgressEvent) => void
  onSubagentStarted?: (event: DelegateCodingTaskStartedEvent) => void
  jotdownStore?: JotdownStore
  onSubagentFinished?: (event: DelegateCodingTaskFinishedEvent) => void
  imageToTextService?: ImageToTextService
  isModelImageCapable?: boolean
  activityTracker?: {
    finalizeAndConsume(): ActivitySummary | null
  }
}
