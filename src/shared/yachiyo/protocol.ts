export type MessageRole = 'user' | 'assistant'
export type MessageStatus = 'completed' | 'streaming' | 'failed' | 'stopped'
export type RunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'
export type ProviderKind = 'openai' | 'anthropic'

export interface ThreadRecord {
  id: string
  title: string
  updatedAt: string
  preview?: string
}

export interface MessageRecord {
  id: string
  threadId: string
  role: MessageRole
  content: string
  status: MessageStatus
  createdAt: string
  modelId?: string
  providerName?: string
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

export interface SettingsConfig {
  providers: ProviderConfig[]
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
  config: SettingsConfig
  settings: ProviderSettings
}

export interface ChatAccepted {
  runId: string
  thread: ThreadRecord
  userMessage: MessageRecord
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

export interface ThreadArchivedEvent extends ThreadEvent {
  type: 'thread.archived'
}

export interface RunCreatedEvent extends RunEvent {
  type: 'run.created'
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
  | ThreadArchivedEvent
  | RunCreatedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | HarnessStartedEvent
  | HarnessFinishedEvent
  | SettingsUpdatedEvent
