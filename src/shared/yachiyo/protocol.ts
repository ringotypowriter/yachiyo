export type MessageRole = 'user' | 'assistant'
export type MessageStatus = 'completed' | 'streaming' | 'failed' | 'stopped'
export type RunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'
export type ProviderKind = 'openai' | 'anthropic' | 'vertex'
export type ActiveRunEnterBehavior = 'enter-steers' | 'enter-queues-follow-up'
export type SidebarVisibility = 'expanded' | 'collapsed'
export type SendChatMode = 'normal' | 'steer' | 'follow-up'
export type ToolModelMode = 'disabled' | 'custom'
export type MemoryProviderId = 'nowledge-mem'
export type WebReadContentFormat = 'markdown' | 'html'
export type WebReadExtractor = 'defuddle' | 'linkedom-fallback' | 'none'
export type WebSearchProviderId = 'google-browser' | 'exa'
export type BrowserSearchImportSourceId = 'google-chrome'
export type SearchGrepBackend = 'rg' | 'grep' | 'typescript'
export type SearchFileDiscoveryBackend = 'fd' | 'find' | 'typescript'
export type WebReadFailureCode =
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'invalid-filename'
  | 'fetch-failed'
  | 'timeout'
  | 'http-error'
  | 'unsupported-content-type'
  | 'response-too-large'
  | 'empty-body'
  | 'extraction-failed'
  | 'empty-content'
  | 'write-failed'
export type WebSearchFailureCode =
  | 'invalid-query'
  | 'unsupported-provider'
  | 'timeout'
  | 'load-failed'
  | 'extraction-failed'
  | 'provider-failed'
  | 'aborted'
export const DEFAULT_WEB_READ_CONTENT_FORMAT: WebReadContentFormat = 'markdown'
export const DEFAULT_MEMORY_PROVIDER: MemoryProviderId = 'nowledge-mem'
export const DEFAULT_MEMORY_BASE_URL = 'http://127.0.0.1:14242'
export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProviderId = 'google-browser'
export const CORE_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'glob',
  'webRead',
  'webSearch'
] as const
export type ToolCallName = (typeof CORE_TOOL_NAMES)[number]
export type ToolCallStatus = 'running' | 'completed' | 'failed'

const coreToolNameSet = new Set<string>(CORE_TOOL_NAMES)

export const DEFAULT_ENABLED_TOOL_NAMES = [...CORE_TOOL_NAMES] as ToolCallName[]
export const DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR: ActiveRunEnterBehavior = 'enter-steers'
export const DEFAULT_SIDEBAR_VISIBILITY: SidebarVisibility = 'expanded'
export const DEFAULT_TOOL_MODEL_MODE: ToolModelMode = 'disabled'

export function normalizeMemoryProviderId(
  value: unknown,
  fallback: MemoryProviderId = DEFAULT_MEMORY_PROVIDER
): MemoryProviderId {
  return value === 'nowledge-mem' ? value : fallback
}

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

export function isCoreToolName(value: string): value is ToolCallName {
  return coreToolNameSet.has(value)
}

export function normalizeActiveRunEnterBehavior(
  value: unknown,
  fallback: ActiveRunEnterBehavior = DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
): ActiveRunEnterBehavior {
  return value === 'enter-queues-follow-up' || value === 'enter-steers' ? value : fallback
}

export function normalizeSidebarVisibility(
  value: unknown,
  fallback: SidebarVisibility = DEFAULT_SIDEBAR_VISIBILITY
): SidebarVisibility {
  return value === 'collapsed' || value === 'expanded' ? value : fallback
}

export function normalizeToolModelMode(
  value: unknown,
  fallback: ToolModelMode = DEFAULT_TOOL_MODEL_MODE
): ToolModelMode {
  return value === 'disabled' || value === 'custom' ? value : fallback
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

export interface GrepToolCallMatch {
  path: string
  line: number
  text: string
}

export interface GrepToolCallDetails {
  backend: SearchGrepBackend
  pattern: string
  path: string
  resultCount: number
  truncated: boolean
  matches: GrepToolCallMatch[]
}

export interface GlobToolCallDetails {
  backend: SearchFileDiscoveryBackend
  pattern: string
  path: string
  resultCount: number
  truncated: boolean
  matches: string[]
}

export interface WebReadToolCallDetails {
  requestedUrl: string
  finalUrl?: string
  httpStatus?: number
  contentType?: string
  extractor: WebReadExtractor
  title?: string
  author?: string
  siteName?: string
  publishedTime?: string
  description?: string
  content: string
  contentFormat: WebReadContentFormat
  contentChars: number
  truncated: boolean
  originalContentChars?: number
  savedFileName?: string
  savedFilePath?: string
  savedBytes?: number
  failureCode?: WebReadFailureCode
}

export interface WebSearchResultItem {
  title: string
  url: string
  snippet?: string
  rank: number
}

export interface WebSearchToolCallDetails {
  provider: string
  query: string
  searchUrl?: string
  finalUrl?: string
  results: WebSearchResultItem[]
  resultCount: number
  failureCode?: WebSearchFailureCode
}

export type ToolCallDetailsSnapshot =
  | ReadToolCallDetails
  | WriteToolCallDetails
  | EditToolCallDetails
  | BashToolCallDetails
  | GrepToolCallDetails
  | GlobToolCallDetails
  | WebReadToolCallDetails
  | WebSearchToolCallDetails

export interface MessageImageRecord {
  dataUrl: string
  mediaType: string
  filename?: string
}

export interface ThreadRecord {
  archivedAt?: string
  id: string
  title: string
  updatedAt: string
  workspacePath?: string
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
  id?: string
  name: string
  type: ProviderKind
  apiKey: string
  baseUrl: string
  modelList: ProviderModelList
}

export interface ChatConfig {
  activeRunEnterBehavior?: ActiveRunEnterBehavior
}

export interface GeneralConfig {
  sidebarVisibility?: SidebarVisibility
}

export interface UserDocument {
  filePath: string
  content: string
}

export interface WorkspaceConfig {
  savedPaths?: string[]
}

export interface ToolModelConfig {
  mode?: ToolModelMode
  providerId?: string
  providerName?: string
  model?: string
}

export interface MemoryConfig {
  enabled?: boolean
  provider?: MemoryProviderId
  baseUrl?: string
}

export interface BrowserBackedWebSearchSessionConfig {
  sourceBrowser?: BrowserSearchImportSourceId
  sourceProfileName?: string
  importedAt?: string
  lastImportError?: string
}

export interface ExaWebSearchConfig {
  apiKey?: string
  baseUrl?: string
}

export interface WebSearchConfig {
  defaultProvider?: WebSearchProviderId
  browserSession?: BrowserBackedWebSearchSessionConfig
  exa?: ExaWebSearchConfig
}

export interface SettingsConfig {
  providers: ProviderConfig[]
  enabledTools?: ToolCallName[]
  general?: GeneralConfig
  chat?: ChatConfig
  workspace?: WorkspaceConfig
  toolModel?: ToolModelConfig
  memory?: MemoryConfig
  webSearch?: WebSearchConfig
}

export function isMemoryConfigured(
  config: Pick<SettingsConfig, 'memory'> | null | undefined
): boolean {
  if (!config?.memory?.enabled) {
    return false
  }

  const provider = normalizeMemoryProviderId(config.memory.provider)
  const baseUrl = config.memory.baseUrl?.trim() ?? ''
  return provider === 'nowledge-mem' && baseUrl.length > 0
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
  archivedThreads: ThreadRecord[]
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
  requestMessageId?: string
  recalledMemoryEntries?: string[]
}

export interface ChatAcceptedWithUserMessage {
  kind: 'run-started' | 'active-run-steer' | 'active-run-follow-up'
  thread: ThreadRecord
  userMessage: MessageRecord
  runId: string
  replacedMessageId?: string
}

export interface ChatAcceptedPendingSteer {
  kind: 'active-run-steer-pending'
  thread: ThreadRecord
  runId: string
}

export type ChatAccepted = ChatAcceptedWithUserMessage | ChatAcceptedPendingSteer

export interface ToolPreferencesInput {
  enabledTools?: ToolCallName[]
}

export interface WebSearchBrowserImportSource {
  browserId: BrowserSearchImportSourceId
  browserName: string
  profileName: string
  profilePath: string
}

export interface ImportWebSearchBrowserSessionInput {
  sourceBrowser: BrowserSearchImportSourceId
  sourceProfileName: string
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

export interface SaveThreadInput {
  threadId: string
  archiveAfterSave?: boolean
}

export interface RetryAccepted {
  runId: string
  thread: ThreadRecord
  requestMessageId: string
  sourceAssistantMessageId?: string
}

export interface SaveThreadResult {
  archived: boolean
  savedMemoryCount: number
  thread: ThreadRecord
}

export interface TestMemoryConnectionInput {
  config: SettingsConfig
}

export interface TestMemoryConnectionResult {
  message: string
  ok: boolean
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
  thread: ThreadRecord
}

export interface ThreadRestoredEvent extends ThreadEvent {
  type: 'thread.restored'
  thread: ThreadRecord
}

export interface ThreadDeletedEvent extends ThreadEvent {
  type: 'thread.deleted'
}

export interface RunCreatedEvent extends RunEvent {
  type: 'run.created'
  requestMessageId: string
}

export interface RunMemoryRecalledEvent extends RunEvent {
  type: 'run.memory.recalled'
  requestMessageId: string
  recalledMemoryEntries: string[]
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
  | ThreadRestoredEvent
  | ThreadDeletedEvent
  | RunCreatedEvent
  | RunMemoryRecalledEvent
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
