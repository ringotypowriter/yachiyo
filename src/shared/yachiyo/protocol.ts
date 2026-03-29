export type ChannelUserStatus = 'pending' | 'allowed' | 'blocked'
export type ChannelUserRole = 'owner' | 'guest'
export type ChannelPlatform = 'telegram' | 'qq' | 'discord'

export interface ChannelUserRecord {
  id: string
  platform: ChannelPlatform
  externalUserId: string
  username: string
  status: ChannelUserStatus
  role: ChannelUserRole
  usageLimitKTokens: number | null
  usedKTokens: number
  workspacePath: string
}

export interface UpdateChannelUserInput {
  id: string
  status?: ChannelUserStatus
  role?: ChannelUserRole
  usageLimitKTokens?: number | null
  usedKTokens?: number
}

// ---------------------------------------------------------------------------
// Channel Groups (group discussion mode)
// ---------------------------------------------------------------------------

export type ChannelGroupStatus = 'pending' | 'approved' | 'blocked'
export type GroupMonitorPhase = 'dormant' | 'active' | 'engaged'

export interface ChannelGroupRecord {
  id: string
  platform: ChannelPlatform
  externalGroupId: string
  name: string
  status: ChannelGroupStatus
  workspacePath: string
  createdAt: string
}

export interface UpdateChannelGroupInput {
  id: string
  status?: ChannelGroupStatus
  name?: string
}

/** A single message in the group monitor's recent-message buffer. */
export interface GroupMessageEntry {
  senderName: string
  senderExternalUserId: string
  /** Whether this message @mentions the bot. */
  isMention: boolean
  text: string
  /** Resolved images attached to this message (already vision-safe). */
  images?: MessageImageRecord[]
  /** Unix seconds. */
  timestamp: number
}

/** Per-platform group discussion settings (from channels.toml). */
export interface GroupChannelConfig {
  enabled: boolean
  /** Model override for the group probe call. When set, overrides the default tool model. */
  model?: ThreadModelOverride
  /** When true, pass images from group messages to the probe model. Default false. */
  vision?: boolean
  activeCheckIntervalMs?: number
  engagedCheckIntervalMs?: number
  wakeBufferMs?: number
  dormancyMissCount?: number
  disengageMissCount?: number
}

export type MessageRole = 'user' | 'assistant'
export type MessageStatus = 'completed' | 'streaming' | 'failed' | 'stopped'
export type RunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'
export type ProviderKind =
  | 'openai'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'vertex'
  | 'vercel-gateway'
export type ActiveRunEnterBehavior = 'enter-steers' | 'enter-queues-follow-up'
export type SidebarVisibility = 'expanded' | 'collapsed'
export type SendChatMode = 'normal' | 'steer' | 'follow-up'
export type ToolModelMode = 'disabled' | 'custom'
export type MemoryProviderId = 'builtin-memory' | 'nowledge-mem'
export type WebReadRequestFormat = 'markdown' | 'html'
export type WebReadContentFormat = WebReadRequestFormat | 'raw'
export type WebReadExtractor = 'defuddle' | 'linkedom-fallback' | 'none'
export type WebSearchProviderId = 'google-browser' | 'exa'
export type BrowserSearchImportSourceId = 'google-chrome'
export type SearchGrepBackend = 'rg' | 'grep' | 'typescript'
export type SearchFileDiscoveryBackend = 'fd' | 'find' | 'typescript'
export type WebReadFailureCode =
  | 'invalid-url'
  | 'unsupported-protocol'
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
export const DEFAULT_WEB_READ_CONTENT_FORMAT: WebReadRequestFormat = 'markdown'
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
  'webSearch',
  'skillsRead'
] as const
export type ToolCallName = (typeof CORE_TOOL_NAMES)[number]
export type ToolCallStatus = 'running' | 'completed' | 'failed'

const coreToolNameSet = new Set<string>(CORE_TOOL_NAMES)
const runtimeManagedToolNameSet = new Set<ToolCallName>(['skillsRead'])
const userManagedToolNames = CORE_TOOL_NAMES.filter(
  (toolName) => !runtimeManagedToolNameSet.has(toolName)
)

export const USER_MANAGED_TOOL_NAMES = [...userManagedToolNames] as ToolCallName[]
export const DEFAULT_ENABLED_TOOL_NAMES = [...USER_MANAGED_TOOL_NAMES] as ToolCallName[]
export const DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR: ActiveRunEnterBehavior = 'enter-steers'
export const DEFAULT_SIDEBAR_VISIBILITY: SidebarVisibility = 'expanded'
export const DEFAULT_TOOL_MODEL_MODE: ToolModelMode = 'disabled'

export function normalizeMemoryProviderId(
  value: unknown,
  fallback: MemoryProviderId = DEFAULT_MEMORY_PROVIDER
): MemoryProviderId {
  return value === 'builtin-memory' || value === 'nowledge-mem' ? value : fallback
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

export function normalizeUserEnabledTools(
  value: unknown,
  fallback: readonly ToolCallName[] = DEFAULT_ENABLED_TOOL_NAMES
): ToolCallName[] {
  const fallbackSet = new Set(USER_MANAGED_TOOL_NAMES)
  const normalizedFallback = normalizeEnabledTools(fallback).filter((toolName) =>
    fallbackSet.has(toolName)
  )
  const normalizedTools = normalizeEnabledTools(value, normalizedFallback)

  return normalizedTools.filter((toolName) => fallbackSet.has(toolName))
}

export function normalizeSkillNames(value: unknown, fallback: readonly string[] = []): string[] {
  if (!Array.isArray(value)) {
    return [...fallback]
  }

  const names: string[] = []
  const seen = new Set<string>()

  for (const item of value) {
    if (typeof item !== 'string') {
      continue
    }

    const name = item.trim()
    if (!name || seen.has(name)) {
      continue
    }

    seen.add(name)
    names.push(name)
  }

  return names
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
  /** Set for image reads; contains the IANA media type e.g. "image/png". */
  mediaType?: string
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

export interface SkillsReadRecord {
  name: string
  directoryPath: string
  skillFilePath: string
  description?: string
  content?: string
}

export interface SkillsReadToolCallDetails {
  requestedNames: string[]
  resolvedCount: number
  skills: SkillsReadRecord[]
  missingNames?: string[]
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
  | SkillsReadToolCallDetails

export interface MessageImageRecord {
  dataUrl: string
  mediaType: string
  filename?: string
  workspacePath?: string
  /** Pre-generated alt text description from the image-to-text service. */
  altText?: string
}

export interface MessageFileAttachment {
  filename: string
  mediaType: string
  workspacePath: string
}

export interface MessageTextBlockRecord {
  id: string
  content: string
  createdAt: string
}

export interface ThreadModelOverride {
  providerName: string
  model: string
}

export interface ThreadRecord {
  archivedAt?: string
  starredAt?: string
  icon?: string
  id: string
  title: string
  updatedAt: string
  memoryRecall?: ThreadMemoryRecallState
  workspacePath?: string
  preview?: string
  headMessageId?: string
  queuedFollowUpMessageId?: string
  queuedFollowUpEnabledTools?: ToolCallName[]
  queuedFollowUpEnabledSkillNames?: string[]
  branchFromThreadId?: string
  branchFromMessageId?: string
  privacyMode?: boolean
  modelOverride?: ThreadModelOverride
  source?: 'local' | ChannelPlatform
  channelUserId?: string
  channelGroupId?: string
  /** Compact, external-safe summary of the conversation state. Updated at compaction time. */
  rollingSummary?: string
  /** Messages up to this ID are covered by rollingSummary. Transcript window starts after. */
  summaryWatermarkMessageId?: string
}

/** Per-turn injected context (reminder, memory) persisted for lossless replay. */
export interface MessageTurnContext {
  reminder?: string
  memoryEntries?: string[]
}

export interface MessageRecord {
  id: string
  threadId: string
  parentMessageId?: string
  role: MessageRole
  content: string
  textBlocks?: MessageTextBlockRecord[]
  images?: MessageImageRecord[]
  attachments?: MessageFileAttachment[]
  reasoning?: string
  /** Structured AI SDK response messages from tool-using runs, stored for lossless history replay. */
  responseMessages?: unknown[]
  /** Per-turn injected context for this request, persisted separately from user-authored content. */
  turnContext?: MessageTurnContext
  /** Channel-visible reply extracted from raw content. Only set for external-channel assistant messages. */
  visibleReply?: string
  /** Display name of the sender in a group conversation. Null for DM and bot's own messages. */
  senderName?: string
  /** External platform user ID of the sender. Null for DM and bot's own messages. */
  senderExternalUserId?: string
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
  toolName: ToolCallName | string
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
  thinkingEnabled?: boolean
  // Used by openai, openai-responses, anthropic, gemini, vercel-gateway
  apiKey: string
  baseUrl: string
  // Used by vertex only
  project?: string
  location?: string
  serviceAccountEmail?: string
  serviceAccountPrivateKey?: string
  modelList: ProviderModelList
}

export interface ChatConfig {
  activeRunEnterBehavior?: ActiveRunEnterBehavior
}

export interface GeneralConfig {
  sidebarVisibility?: SidebarVisibility
  uiFontSize?: number
  chatFontSize?: number
  notifyRunCompleted?: boolean
  notifyCodingTaskStarted?: boolean
  notifyCodingTaskFinished?: boolean
}

export interface UserDocument {
  filePath: string
  content: string
}

export interface SoulDocument {
  filePath: string
  evolvedTraits: string[]
  lastUpdated: string
}

export interface MemoryTermEntry {
  id: string
  title: string
  content: string
  unitType:
    | 'fact'
    | 'preference'
    | 'decision'
    | 'plan'
    | 'procedure'
    | 'learning'
    | 'context'
    | 'event'
  importance?: number
  updatedAt: string
}

export interface MemoryTermTopic {
  topic: string
  entryCount: number
  entries: MemoryTermEntry[]
}

export interface MemoryTermDocument {
  provider: MemoryProviderId
  topicCount: number
  memoryCount: number
  topics: MemoryTermTopic[]
}

export interface WorkspaceConfig {
  savedPaths?: string[]
  editorApp?: string
  terminalApp?: string
}

export interface ToolModelConfig {
  mode?: ToolModelMode
  providerId?: string
  providerName?: string
  model?: string
}

export interface SkillsConfig {
  enabled?: string[]
}

export interface MemoryConfig {
  enabled?: boolean
  provider?: MemoryProviderId
  baseUrl?: string
}

export interface ThreadMemoryRecallEntry {
  memoryId: string
  fingerprint: string
  injectedAt: string
  messageCount: number
  charCount: number
  score?: number
}

export interface ThreadMemoryRecallState {
  lastRunAt?: string
  lastRecallAt?: string
  lastRecallMessageCount?: number
  lastRecallCharCount?: number
  recentInjections?: ThreadMemoryRecallEntry[]
}

export interface RecallDecisionSnapshot {
  shouldRecall: boolean
  score: number
  reasons: string[]
  messagesSinceLastRecall: number
  charsSinceLastRecall: number
  idleMs: number
  noveltyScore: number
  novelTerms: string[]
}

export type RunContextSourceKind =
  | 'persona'
  | 'soul'
  | 'user'
  | 'agent'
  | 'skills'
  | 'fileMentions'
  | 'memory'
  | 'handoff'
  | 'hint'
  | 'toolReminder'

export interface RunContextSourceSummary {
  kind: RunContextSourceKind
  present: boolean
  summary?: string
  count?: number
  reasons?: string[]
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

export interface SkillSummary {
  name: string
  description?: string
}

export interface SkillCatalogEntry extends SkillSummary {
  directoryPath: string
  skillFilePath: string
}

export interface SubagentProfile {
  id: string
  name: string
  enabled: boolean
  description: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface FileMentionCandidate {
  path: string
}

export interface SearchWorkspaceFilesInput {
  query: string
  includeIgnored?: boolean
  threadId?: string
  workspacePath?: string | null
  limit?: number
}

export interface UserPrompt {
  keycode: string
  text: string
}

const KEYCODE_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/

export function normalizeUserPrompts(value: unknown): UserPrompt[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: UserPrompt[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const keycode =
      typeof (item as Record<string, unknown>).keycode === 'string'
        ? ((item as Record<string, unknown>).keycode as string).trim()
        : ''
    const text =
      typeof (item as Record<string, unknown>).text === 'string'
        ? ((item as Record<string, unknown>).text as string).trim()
        : ''
    if (!keycode || !KEYCODE_RE.test(keycode) || !text || seen.has(keycode)) continue
    seen.add(keycode)
    result.push({ keycode, text })
  }
  return result
}

export interface TelegramChannelConfig {
  /** Whether the Telegram bot is active. */
  enabled: boolean
  /** Bot API token from @BotFather. Stored in channels.toml, never in config.toml. */
  botToken: string
  /** Optional model override for Telegram threads. */
  model?: ThreadModelOverride
  /** Group discussion mode settings. */
  group?: GroupChannelConfig
}

export interface QQChannelConfig {
  /** Whether the QQ bot is active. */
  enabled: boolean
  /** NapCatQQ forward WebSocket URL (e.g. "ws://localhost:3001"). */
  wsUrl: string
  /** Optional auth token for the WS connection. */
  token?: string
  /** Optional model override for QQ threads. */
  model?: ThreadModelOverride
  /** Group discussion mode settings. */
  group?: GroupChannelConfig
}

export interface DiscordChannelConfig {
  /** Whether the Discord bot is active. */
  enabled: boolean
  /** Discord bot token from the Developer Portal. */
  botToken: string
  /** Optional model override for Discord threads. */
  model?: ThreadModelOverride
  /** Group discussion mode settings (server text channels). */
  group?: GroupChannelConfig
}

export interface ImageToTextConfig {
  /** When true, images in group messages are pre-described as alt text. Default false. */
  enabled?: boolean
  /** Model override for the vision model. Falls back to tool model when unset. */
  model?: ThreadModelOverride
}

export interface ChannelsConfig {
  telegram?: TelegramChannelConfig
  qq?: QQChannelConfig
  discord?: DiscordChannelConfig
  /** Keywords to redact from memory search results in guest conversations. */
  memoryFilterKeywords?: string[]
  /** Custom instruction injected into the system prompt for guest conversations. */
  guestInstruction?: string
  /** Image-to-text description service settings. */
  imageToText?: ImageToTextConfig
}

export interface SettingsConfig {
  providers: ProviderConfig[]
  defaultModel?: ThreadModelOverride
  enabledTools?: ToolCallName[]
  general?: GeneralConfig
  chat?: ChatConfig
  workspace?: WorkspaceConfig
  toolModel?: ToolModelConfig
  skills?: SkillsConfig
  memory?: MemoryConfig
  webSearch?: WebSearchConfig
  prompts?: UserPrompt[]
  subagentProfiles?: SubagentProfile[]
}

export function isMemoryConfigured(
  config: Pick<SettingsConfig, 'memory'> | null | undefined
): boolean {
  if (!config?.memory?.enabled) {
    return false
  }

  const provider = normalizeMemoryProviderId(config.memory.provider)
  if (provider === 'builtin-memory') {
    return true
  }

  const baseUrl = config.memory.baseUrl?.trim() ?? ''
  return provider === 'nowledge-mem' && baseUrl.length > 0
}

export interface ProviderSettings {
  providerName: string
  provider: ProviderKind
  model: string
  thinkingEnabled?: boolean
  // Used by openai, openai-responses, anthropic, gemini, vercel-gateway
  apiKey: string
  baseUrl: string
  // Used by vertex only
  project?: string
  location?: string
  serviceAccountEmail?: string
  serviceAccountPrivateKey?: string
}

export interface BootstrapPayload {
  threads: ThreadRecord[]
  archivedThreads: ThreadRecord[]
  messagesByThread: Record<string, MessageRecord[]>
  toolCallsByThread: Record<string, ToolCallRecord[]>
  latestRunsByThread: Record<string, RunRecord>
  recoveredInterruptedSaveThreadIds: string[]
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
  recallDecision?: RecallDecisionSnapshot
  contextSources?: RunContextSourceSummary[]
  promptTokens?: number
  completionTokens?: number
  totalPromptTokens?: number
  totalCompletionTokens?: number
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

export interface ListSkillsInput {
  workspacePaths?: string[]
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

export interface SendChatAttachment {
  filename: string
  mediaType: string
  dataUrl: string
}

export interface SendChatInput {
  threadId: string
  content: string
  images?: MessageImageRecord[]
  attachments?: SendChatAttachment[]
  enabledTools?: ToolCallName[]
  enabledSkillNames?: string[]
  mode?: SendChatMode
  /**
   * Optional per-turn hint injected into the hint layer before the model sees
   * the user message. Used by channel integrations (e.g. Telegram) to enforce
   * reply-format instructions without polluting stored message content.
   */
  channelHint?: string
}

export interface RetryInput {
  threadId: string
  messageId: string
  enabledTools?: ToolCallName[]
  enabledSkillNames?: string[]
}

export interface EditMessageInput {
  threadId: string
  messageId: string
  content: string
  images?: MessageImageRecord[]
  attachments?: SendChatAttachment[]
  enabledTools?: ToolCallName[]
  enabledSkillNames?: string[]
}

export interface CompactThreadInput {
  threadId: string
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

export interface CompactThreadAccepted {
  runId: string
  sourceThreadId: string
  thread: ThreadRecord
}

export interface SaveThreadResult {
  archived: boolean
  savedMemoryCount: number
  thread: ThreadRecord
}

export interface GetMemoryTermDocumentInput {
  config?: SettingsConfig
}

export interface TestMemoryConnectionInput {
  config: SettingsConfig
}

export interface TestMemoryConnectionResult {
  message: string
  ok: boolean
}

export interface TestSubagentProfileInput {
  profile: SubagentProfile
}

export interface TestSubagentProfileResult {
  ok: boolean
  error?: string
}

export interface ThreadSnapshot {
  thread: ThreadRecord
  messages: MessageRecord[]
  toolCalls: ToolCallRecord[]
}

export interface ThreadSearchMessageMatch {
  messageId: string
  snippet: string
}

export interface ThreadSearchResult {
  threadId: string
  threadTitle: string
  threadUpdatedAt: string
  titleMatched: boolean
  messageMatches: ThreadSearchMessageMatch[]
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
  requestMessageId?: string
}

export interface RunMemoryRecalledEvent extends RunEvent {
  type: 'run.memory.recalled'
  requestMessageId?: string
  recalledMemoryEntries: string[]
  recallDecision?: RecallDecisionSnapshot
}

export interface RunContextCompiledEvent extends RunEvent {
  type: 'run.context.compiled'
  contextSources: RunContextSourceSummary[]
}

export interface RunCompletedEvent extends RunEvent {
  type: 'run.completed'
  promptTokens?: number
  completionTokens?: number
  totalPromptTokens?: number
  totalCompletionTokens?: number
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

export interface SubagentStartedEvent extends RunEvent {
  type: 'subagent.started'
  agentName: string
}

export interface SubagentFinishedEvent extends RunEvent {
  type: 'subagent.finished'
  agentName: string
  status: 'success' | 'cancelled'
}

export interface SubagentProgressEvent extends RunEvent {
  type: 'subagent.progress'
  chunk: string
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
  | RunContextCompiledEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageReasoningDeltaEvent
  | MessageCompletedEvent
  | ToolCallUpdatedEvent
  | HarnessStartedEvent
  | HarnessFinishedEvent
  | SettingsUpdatedEvent
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | SubagentProgressEvent
