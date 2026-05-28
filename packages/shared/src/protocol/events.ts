import type {
  FolderRecord,
  MessageRecord,
  NamedSubagentId,
  ProviderSettings,
  RecallDecisionSnapshot,
  RunContextSourceSummary,
  RunModeId,
  SendChatRunTrigger,
  SettingsConfig,
  ThreadSentinelRecord,
  ThreadRecord,
  ToolCallRecord
} from '../protocol.ts'

interface BaseEvent {
  eventId: string
  timestamp: string
  type: string
}

interface ThreadEvent extends BaseEvent {
  threadId: string
}

interface RunEvent extends ThreadEvent {
  runId: string
  requestMessageId?: string
  runTrigger?: SendChatRunTrigger
}

export type TodoItemStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItemRecord {
  id: string
  content: string
  status: TodoItemStatus
}

export interface ThreadCreatedEvent extends ThreadEvent {
  type: 'thread.created'
  thread: ThreadRecord
}

export interface ThreadUpdatedEvent extends ThreadEvent {
  type: 'thread.updated'
  thread: ThreadRecord
}

export interface ThreadStateReplacedEvent extends ThreadEvent {
  type: 'thread.state.replaced'
  thread: ThreadRecord
  messages: MessageRecord[]
  toolCalls: ToolCallRecord[]
}

export interface ThreadArchivedEvent extends ThreadEvent {
  type: 'thread.archived'
  thread: ThreadRecord
}

export interface ThreadRestoredEvent extends ThreadEvent {
  type: 'thread.restored'
  thread: ThreadRecord
}

export interface ThreadDeletedEvent extends ThreadEvent {
  type: 'thread.deleted'
}

export interface ThreadSentinelUpdatedEvent extends ThreadEvent {
  type: 'thread.sentinel.updated'
  sentinel?: ThreadSentinelRecord
}

export interface RunCreatedEvent extends RunEvent {
  type: 'run.created'
  runMode?: RunModeId
}

export interface RunMemoryRecalledEvent extends RunEvent {
  type: 'run.memory.recalled'
  recalledMemoryEntries: string[]
  recallDecision?: RecallDecisionSnapshot
}

export interface RunContextCompiledEvent extends RunEvent {
  type: 'run.context.compiled'
  contextSources: RunContextSourceSummary[]
}

export interface RunUsageUpdatedEvent extends RunEvent {
  type: 'run.usage.updated'
  promptTokens: number
  completionTokens: number
}

export interface RunCompletedEvent extends RunEvent {
  type: 'run.completed'
  recap?: boolean
  promptTokens?: number
  completionTokens?: number
  totalPromptTokens?: number
  totalCompletionTokens?: number
}

export interface RunRetryingEvent extends RunEvent {
  type: 'run.retrying'
  attempt: number
  maxAttempts: number
  delayMs: number
  error: string
}

export interface RunFailedEvent extends RunEvent {
  type: 'run.failed'
  error: string
}

export interface BackgroundTaskCompletedEvent extends ThreadEvent {
  type: 'background-task.completed'
  taskId: string
  command: string
  logPath: string
  exitCode: number
  toolCallId?: string
  cancelledByUser?: boolean
}

export type BackgroundTaskSnapshotStatus = 'running' | 'completed' | 'failed'

export interface BackgroundTaskSnapshot {
  taskId: string
  threadId: string
  command: string
  logPath: string
  startedAt: string
  status: BackgroundTaskSnapshotStatus
  exitCode?: number
  finishedAt?: string
  cancelledByUser?: boolean
  /** Last N lines of the on-disk log, populated by the server on hydration. */
  recentLogTail?: string[]
}

export const BACKGROUND_TASK_LOG_DEFAULT_MAX_BYTES = 256 * 1024
export const BACKGROUND_TASK_LOG_HARD_MAX_BYTES = 1024 * 1024

export interface BackgroundTaskLogSnapshot {
  taskId: string
  threadId: string
  command: string
  logPath: string
  content: string
  truncated: boolean
  totalBytes: number
  startByte: number
}

export interface BackgroundTaskStartedEvent extends ThreadEvent {
  type: 'background-task.started'
  taskId: string
  command: string
  startedAt: string
}

export interface BackgroundTaskLogAppendEvent extends ThreadEvent {
  type: 'background-task.log-append'
  taskId: string
  lines: string[]
}

export interface RunCancelledEvent extends RunEvent {
  type: 'run.cancelled'
  recap?: boolean
}

export interface SnapshotReadyEvent extends RunEvent {
  type: 'snapshot.ready'
  fileCount: number
  workspacePath: string
}

export interface MessageStartedEvent extends RunEvent {
  type: 'message.started'
  messageId: string
  parentMessageId?: string
}

export interface MessageDeltaEvent extends RunEvent {
  type: 'message.delta'
  messageId: string
  delta: string
}

export interface MessageReasoningDeltaEvent extends RunEvent {
  type: 'message.reasoning.delta'
  messageId: string
  delta: string
}

export interface MessageCompletedEvent extends RunEvent {
  type: 'message.completed'
  message: MessageRecord
}

export interface ToolCallUpdatedEvent extends ThreadEvent {
  type: 'tool.updated'
  runId?: string
  toolCall: ToolCallRecord
}

export interface TodoUpdatedEvent extends RunEvent {
  type: 'todo.updated'
  items: TodoItemRecord[]
}

export interface SettingsUpdatedEvent extends BaseEvent {
  type: 'settings.updated'
  config: SettingsConfig
  settings: ProviderSettings
}

export interface SubagentStartedEvent extends RunEvent {
  type: 'subagent.started'
  delegationId: string
  agentName: string
  agentType?: NamedSubagentId | string
  workspacePath: string
  startedAt?: string
}

export interface SubagentFinishedEvent extends RunEvent {
  type: 'subagent.finished'
  delegationId: string
  agentName: string
  agentType?: NamedSubagentId | string
  status: 'success' | 'cancelled'
  sessionId?: string
}

export interface SubagentProgressEvent extends RunEvent {
  type: 'subagent.progress'
  delegationId: string
  chunk: string
}

export interface NotificationRequestEvent extends RunEvent {
  type: 'notification.requested'
  title: string
  body: string
}

export interface ChannelGroupHistoryClearStartedEvent extends BaseEvent {
  type: 'channel-group-history-clear.started'
  groupId: string
}

export interface ChannelGroupHistoryClearCompletedEvent extends BaseEvent {
  type: 'channel-group-history-clear.completed'
  groupId: string
}

export interface ChannelGroupHistoryClearFailedEvent extends BaseEvent {
  type: 'channel-group-history-clear.failed'
  groupId: string
  error: string
}

// Folder events
interface FolderEvent extends BaseEvent {
  folderId: string
}

export interface FolderCreatedEvent extends FolderEvent {
  type: 'folder.created'
  folder: FolderRecord
}

export interface FolderUpdatedEvent extends FolderEvent {
  type: 'folder.updated'
  folder: FolderRecord
}

export interface FolderDeletedEvent extends FolderEvent {
  type: 'folder.deleted'
}

export type YachiyoServerEvent =
  | FolderCreatedEvent
  | FolderUpdatedEvent
  | FolderDeletedEvent
  | ThreadCreatedEvent
  | ThreadUpdatedEvent
  | ThreadStateReplacedEvent
  | ThreadArchivedEvent
  | ThreadRestoredEvent
  | ThreadDeletedEvent
  | ThreadSentinelUpdatedEvent
  | RunCreatedEvent
  | RunMemoryRecalledEvent
  | RunContextCompiledEvent
  | RunUsageUpdatedEvent
  | RunCompletedEvent
  | RunRetryingEvent
  | RunFailedEvent
  | RunCancelledEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageReasoningDeltaEvent
  | MessageCompletedEvent
  | ToolCallUpdatedEvent
  | TodoUpdatedEvent
  | SettingsUpdatedEvent
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | SubagentProgressEvent
  | NotificationRequestEvent
  | ChannelGroupHistoryClearStartedEvent
  | ChannelGroupHistoryClearCompletedEvent
  | ChannelGroupHistoryClearFailedEvent
  | BackgroundTaskCompletedEvent
  | BackgroundTaskStartedEvent
  | BackgroundTaskLogAppendEvent
  | SnapshotReadyEvent
