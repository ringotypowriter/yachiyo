export type MessageRole = 'user' | 'assistant'
export type MessageStatus = 'completed' | 'streaming' | 'failed' | 'stopped'
export type RunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'
export type ProviderKind = 'openai' | 'anthropic'
export type ActiveRunEnterBehavior = 'enter-steers' | 'enter-queues-follow-up'
export type SendChatMode = 'normal' | 'steer' | 'follow-up'
export const CORE_TOOL_NAMES = ['read', 'write', 'edit', 'bash'] as const
export type ToolCallName = (typeof CORE_TOOL_NAMES)[number]
export type ToolCallStatus = 'running' | 'completed' | 'failed'

const coreToolNameSet = new Set<string>(CORE_TOOL_NAMES)

export const DEFAULT_ENABLED_TOOL_NAMES = [...CORE_TOOL_NAMES] as ToolCallName[]
export const DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR: ActiveRunEnterBehavior = 'enter-steers'

export function normalizeEnabledTools(
  value: unknown,
  fallback: readonly ToolCallName[] = DEFAULT_ENABLED_TOOL_NAMES
): ToolCallName[] {
  if (!Array.isArray(value)) {
    return [...fallback]
  }

  const enabledTools: ToolCallName[] = []
  const seen = new Set<ToolCallName>()

  for (const item of value) {
    if (typeof item !== 'string' || !coreToolNameSet.has(item)) {
      continue
    }

    const toolName = item as ToolCallName
    if (seen.has(toolName)) {
      continue
    }

    seen.add(toolName)
    enabledTools.push(toolName)
  }

  return enabledTools
}

export function normalizeActiveRunEnterBehavior(
  value: unknown,
  fallback: ActiveRunEnterBehavior = DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
): ActiveRunEnterBehavior {
  return value === 'enter-queues-follow-up' || value === 'enter-steers' ? value : fallback
}

export interface ReadToolCallDetails {
  path: string
  startLine: number
  endLine: number
  totalLines: number
  totalBytes: number
  truncated: boolean
  nextOffset?: number
  remainingLines?: number
}

export interface WriteToolCallDetails {
  path: string
  bytesWritten: number
  created: boolean
  overwritten: boolean
}

export interface EditToolCallDetails {
  path: string
  replacements: number
  diff?: string
  firstChangedLine?: number
}

export interface BashToolCallDetails {
  command: string
  cwd: string
  exitCode?: number
  stdout: string
  stderr: string
  truncated?: boolean
  timedOut?: boolean
  blocked?: boolean
  outputFilePath?: string
}

export type ToolCallDetailsSnapshot =
  | ReadToolCallDetails
  | WriteToolCallDetails
  | EditToolCallDetails
  | BashToolCallDetails

export interface MessageImageRecord {
  dataUrl: string
  mediaType: string
  filename?: string
}

export interface ThreadRecord {
  id: string
  title: string
  updatedAt: string
  preview?: string
  headMessageId?: string
  queuedFollowUpMessageId?: string
  queuedFollowUpEnabledTools?: ToolCallName[]
  branchFromThreadId?: string
  branchFromMessageId?: string
}

export interface MessageRecord {
  id: string
  threadId: string
  parentMessageId?: string
  role: MessageRole
  content: string
  images?: MessageImageRecord[]
  status: MessageStatus
  createdAt: string
  modelId?: string
  providerName?: string
}

export interface ToolCallRecord {
  id: string
  runId: string
  threadId: string
  requestMessageId?: string
  assistantMessageId?: string
  toolName: ToolCallName
  status: ToolCallStatus
  inputSummary: string
  outputSummary?: string
  cwd?: string
  error?: string
  details?: ToolCallDetailsSnapshot
  startedAt: string
  finishedAt?: string
}

export interface ProviderModelList {
  enabled: string[]
  disabled: string[]
}

export interface ProviderConfig {
  name: string
  type: ProviderKind
  apiKey: string
  baseUrl: string
  modelList: ProviderModelList
}

export interface ChatConfig {
  activeRunEnterBehavior?: ActiveRunEnterBehavior
}

export interface SettingsConfig {
  providers: ProviderConfig[]
  enabledTools?: ToolCallName[]
  chat?: ChatConfig
}

export interface ProviderSettings {
  providerName: string
  provider: ProviderKind
  model: string
  apiKey: string
  baseUrl: string
}

export interface BootstrapPayload {
  threads: ThreadRecord[]
  messagesByThread: Record<string, MessageRecord[]>
  toolCallsByThread: Record<string, ToolCallRecord[]>
  latestRunsByThread: Record<string, RunRecord>
  config: SettingsConfig
  settings: ProviderSettings
}

export interface RunRecord {
  id: string
  threadId: string
  status: Exclude<RunStatus, 'idle'>
  error?: string
  createdAt: string
  completedAt?: string
}

export interface ChatAccepted {
  kind: 'run-started' | 'active-run-steer' | 'active-run-follow-up'
  thread: ThreadRecord
  userMessage: MessageRecord
  runId: string
  replacedMessageId?: string
}

export interface ToolPreferencesInput {
  enabledTools?: ToolCallName[]
}

export interface SendChatInput {
  threadId: string
  content: string
  images?: MessageImageRecord[]
  enabledTools?: ToolCallName[]
  mode?: SendChatMode
}

export interface RetryInput {
  threadId: string
  messageId: string
  enabledTools?: ToolCallName[]
}

export interface RetryAccepted {
  runId: string
  thread: ThreadRecord
  requestMessageId: string
  sourceAssistantMessageId?: string
}

export interface ThreadSnapshot {
  thread: ThreadRecord
  messages: MessageRecord[]
  toolCalls: ToolCallRecord[]
}

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
}

export interface RunCreatedEvent extends RunEvent {
  type: 'run.created'
  requestMessageId: string
}

export interface RunCompletedEvent extends RunEvent {
  type: 'run.completed'
}

export interface RunFailedEvent extends RunEvent {
  type: 'run.failed'
  error: string
}

export interface RunCancelledEvent extends RunEvent {
  type: 'run.cancelled'
}

export interface MessageStartedEvent extends RunEvent {
  type: 'message.started'
  messageId: string
  parentMessageId: string
}

export interface MessageDeltaEvent extends RunEvent {
  type: 'message.delta'
  messageId: string
  delta: string
}

export interface MessageCompletedEvent extends RunEvent {
  type: 'message.completed'
  message: MessageRecord
}

export interface ToolCallUpdatedEvent extends RunEvent {
  type: 'tool.updated'
  toolCall: ToolCallRecord
}

export interface HarnessStartedEvent extends RunEvent {
  type: 'harness.started'
  harnessId: string
  name: string
}

export interface HarnessFinishedEvent extends RunEvent {
  type: 'harness.finished'
  harnessId: string
  name: string
  status: 'completed' | 'failed' | 'cancelled'
  error?: string
}

export interface SettingsUpdatedEvent extends BaseEvent {
  type: 'settings.updated'
  config: SettingsConfig
  settings: ProviderSettings
}

export type YachiyoServerEvent =
  | ThreadCreatedEvent
  | ThreadUpdatedEvent
  | ThreadStateReplacedEvent
  | ThreadArchivedEvent
  | RunCreatedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ToolCallUpdatedEvent
  | HarnessStartedEvent
  | HarnessFinishedEvent
  | SettingsUpdatedEvent
