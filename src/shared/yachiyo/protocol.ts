export type ChannelUserStatus = 'pending' | 'allowed' | 'blocked'
export type ChannelUserRole = 'owner' | 'guest'
export type ChannelPlatform = 'telegram' | 'qq' | 'discord' | 'qqbot'

export interface ChannelUserRecord {
  id: string
  platform: ChannelPlatform
  externalUserId: string
  username: string
  label: string
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
  label?: string
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
  label: string
  status: ChannelGroupStatus
  workspacePath: string
  createdAt: string
}

export interface UpdateChannelGroupInput {
  id: string
  status?: ChannelGroupStatus
  name?: string
  label?: string
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
export type ToolModelMode = 'disabled' | 'default' | 'custom'
export type MemoryProviderId = 'builtin-memory' | 'nowledge-mem'
export type WebReadRequestFormat = 'markdown' | 'html'
export type WebReadContentFormat = WebReadRequestFormat | 'raw'
export type WebReadExtractor = 'defuddle' | 'linkedom-fallback' | 'none'
export type WebSearchProviderId = 'google-browser' | 'exa'
export type BrowserSearchImportSourceId = 'google-chrome'
export type SearchGrepBackend = 'rg' | 'typescript'
export type SearchFileDiscoveryBackend = 'fd' | 'typescript'
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

export const DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD = 200_000
export const DEFAULT_WEB_READ_CONTENT_FORMAT: WebReadRequestFormat = 'markdown'
export const DEFAULT_MEMORY_PROVIDER: MemoryProviderId = 'builtin-memory'
export const DEFAULT_MEMORY_BASE_URL = 'http://127.0.0.1:14242'
export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProviderId = 'google-browser'
export const CORE_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'jsRepl',
  'grep',
  'glob',
  'webRead',
  'webSearch',
  'skillsRead'
] as const
export type ToolCallName = (typeof CORE_TOOL_NAMES)[number]
export type ToolCallStatus =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting-for-user'
  | 'background'

const coreToolNameSet = new Set<string>(CORE_TOOL_NAMES)
const runtimeManagedToolNameSet = new Set<ToolCallName>(['skillsRead'])
const userManagedToolNames = CORE_TOOL_NAMES.filter(
  (toolName) => !runtimeManagedToolNameSet.has(toolName)
)

export const USER_MANAGED_TOOL_NAMES = [...userManagedToolNames] as ToolCallName[]
const defaultDisabledToolNameSet = new Set<ToolCallName>()
export const DEFAULT_ENABLED_TOOL_NAMES = USER_MANAGED_TOOL_NAMES.filter(
  (name) => !defaultDisabledToolNameSet.has(name)
) as ToolCallName[]
export const DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR: ActiveRunEnterBehavior = 'enter-steers'
export const DEFAULT_SIDEBAR_VISIBILITY: SidebarVisibility = 'expanded'
export const DEFAULT_TOOL_MODEL_MODE: ToolModelMode = 'default'

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

/** Tool names that get tracked in the UI (core tools + runtime meta-tools like askUser). */
const trackedToolNameSet = new Set<string>([
  ...CORE_TOOL_NAMES,
  'askUser',
  'delegateCodingTask',
  'remember',
  'searchMemory',
  'updateProfile'
])

export function isTrackedToolName(value: string): boolean {
  return trackedToolNameSet.has(value)
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
  return value === 'disabled' || value === 'default' || value === 'custom' ? value : fallback
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
  /** Set for PDF reads; total number of pages in the document. */
  totalPages?: number
  /** Whether the result was served from extraction cache. */
  cached?: boolean
}

export interface WriteToolCallDetails {
  path: string
  bytesWritten: number
  created: boolean
  overwritten: boolean
  /** Truncated preview of the written content (first ~50 lines). */
  contentPreview?: string
}

export interface EditToolCallDetails {
  path: string
  mode: 'inline' | 'range' | 'batch'
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
  background?: boolean
  taskId?: string
  logPath?: string
  /** Foreground command exceeded its timeout and was adopted as a background task. */
  liftedAfterTimeout?: boolean
}

export interface JsReplToolCallDetails {
  code: string
  result?: string
  consoleOutput?: string
  error?: string
  timedOut?: boolean
  contextReset?: boolean
  cwd?: string
}

export interface GrepToolCallMatch {
  path: string
  line: number
  text: string
  contextBefore?: string[]
  contextAfter?: string[]
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
  /**
   * Skill provenance, frozen at tool execution time from the catalog entry
   * that resolved this call. Populated on every new `skillsRead` invocation
   * since the origin-freeze change; historical rows written before that may
   * lack the field and fall back to `enrichSkillsReadDetails()` in
   * `dumpThread()` for a best-effort recomputation. Downstream consumers
   * (notably the self-review schedule) should trust this field as the
   * authoritative signal for "was this skill bundled or writable at the
   * time the reviewed run invoked it?".
   */
  origin?: SkillOrigin
}

export interface SkillsReadToolCallDetails {
  requestedNames: string[]
  resolvedCount: number
  skills: SkillsReadRecord[]
  missingNames?: string[]
}

export interface AskUserToolCallDetails {
  kind: 'askUser'
  question: string
  choices?: string[]
  answer?: string
}

export type ToolCallDetailsSnapshot =
  | ReadToolCallDetails
  | WriteToolCallDetails
  | EditToolCallDetails
  | BashToolCallDetails
  | JsReplToolCallDetails
  | GrepToolCallDetails
  | GlobToolCallDetails
  | WebReadToolCallDetails
  | WebSearchToolCallDetails
  | SkillsReadToolCallDetails
  | AskUserToolCallDetails

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

export interface ThreadRuntimeBinding {
  kind: 'llm' | 'acp'
  profileId?: string
  profileName?: string
  sessionId?: string
  sessionStatus?: 'new' | 'active' | 'expired'
  lastSessionBoundAt?: string
}

export interface ThreadCapabilities {
  canRetry: boolean
  canCreateBranch: boolean
  canSelectReplyBranch: boolean
  canEdit: boolean
  canDelete: boolean
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
  handoffFromThreadId?: string
  folderId?: string
  privacyMode?: boolean
  modelOverride?: ThreadModelOverride
  source?: 'local' | ChannelPlatform
  channelUserId?: string
  channelUserRole?: ChannelUserRole
  channelGroupId?: string
  /** Legacy external-safe summary from older external auto-rolling. Preserved for replay. */
  rollingSummary?: string
  /** Messages up to this ID are covered by rollingSummary. Transcript window starts after. */
  summaryWatermarkMessageId?: string
  /** When the user last viewed this archived thread. Null = unread. */
  readAt?: string
  /** Essential preset that spawned this thread. */
  createdFromEssentialId?: string
  /** Schedule that spawned this thread. Set once by the schedule runner at thread creation. */
  createdFromScheduleId?: string
  /** Backend runtime binding: stores kind, ACP profile, and session state. */
  runtimeBinding?: ThreadRuntimeBinding
  /** Derived thread action flags for UI and domain policy checks. */
  capabilities?: ThreadCapabilities
  /** The most recent delegated coding task session, for resume hints. */
  lastDelegatedSession?: {
    agentName: string
    sessionId: string
    workspacePath: string
    timestamp: string
  }
  recapText?: string
}

export function deriveThreadCapabilities(
  runtimeBinding?: ThreadRuntimeBinding
): ThreadCapabilities {
  const actionEnabled = runtimeBinding?.kind !== 'acp'

  return {
    canRetry: actionEnabled,
    canCreateBranch: actionEnabled,
    canSelectReplyBranch: actionEnabled,
    canEdit: actionEnabled,
    canDelete: actionEnabled
  }
}

export function getThreadCapabilities(
  thread: Pick<ThreadRecord, 'capabilities' | 'runtimeBinding'>
): ThreadCapabilities {
  return thread.capabilities ?? deriveThreadCapabilities(thread.runtimeBinding)
}

export function withThreadCapabilities<T extends object>(
  thread: T & {
    runtimeBinding?: ThreadRuntimeBinding
    capabilities?: ThreadCapabilities
  }
): Omit<T, 'capabilities'> & { capabilities: ThreadCapabilities } {
  return {
    ...thread,
    capabilities: deriveThreadCapabilities(thread.runtimeBinding)
  }
}

/** Per-turn injected context (reminder, memory) persisted for lossless replay. */
export interface MessageTurnContext {
  reminder?: string
  memoryEntries?: string[]
  activityText?: string
  enabledTools?: ToolCallName[]
  enabledSkillNames?: string[]
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
  /** When true, the message is excluded from the visible chat timeline (e.g. system-initiated background task completions). */
  hidden?: boolean
  status: MessageStatus
  createdAt: string
  modelId?: string
  providerName?: string
}

export interface ToolCallRecord {
  id: string
  runId?: string
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
  /** 1-based index of this tool call within the current run. */
  stepIndex?: number
  /** Total tool step budget for this run. */
  stepBudget?: number
}

export interface ProviderModelList {
  enabled: string[]
  disabled: string[]
  /** Models explicitly marked as not image-capable. Default: all models are image-capable. */
  imageIncapable?: string[]
}

export interface ProviderConfig {
  id?: string
  /** Stable key linking this provider to a built-in preset (e.g. "openai", "google-vertex"). */
  presetKey?: string
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
  stripCompact?: boolean
  stripCompactThresholdTokens?: number
  autoMemoryDistillation?: boolean
  inputBufferEnabled?: boolean
  recapEnabled?: boolean
  /** Model override for image-to-text descriptions. Falls back to tool model when unset. */
  imageToTextModel?: ThreadModelOverride
}

export type UpdateChannel = 'stable' | 'beta'

export type ActivityTrackingMode = 'off' | 'simple' | 'full'

export interface ActivityTrackingConfig {
  mode: ActivityTrackingMode
  /** Whether the user has explicitly denied accessibility for full mode. */
  accessibilityDenied?: boolean
}

export interface GeneralConfig {
  sidebarVisibility?: SidebarVisibility
  sidebarPreview?: boolean
  uiFontSize?: number
  chatFontSize?: number
  updateChannel?: UpdateChannel
  demoMode?: boolean
  notifyRunCompleted?: boolean
  notifyCodingTaskStarted?: boolean
  notifyCodingTaskFinished?: boolean
  translatorShortcut?: string
  jotdownShortcut?: string
  activityTracking?: ActivityTrackingConfig
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
  pathLabels?: Record<string, string>
  editorApp?: string
  terminalApp?: string
  markdownApp?: string
}

export interface ToolModelConfig {
  mode?: ToolModelMode
  providerId?: string
  providerName?: string
  model?: string
}

export interface SkillsConfig {
  enabled?: string[]
  disabled?: string[]
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
  modelSkipped?: boolean
  modelSkipReason?: string
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
  | 'activity'

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

/**
 * Provenance of a skill on disk. Used to gate destructive writes: `bundled`
 * skills are extracted from the app package at startup and unconditionally
 * overwritten on version bump, so they must be treated as read-only by any
 * in-app authoring or self-review flow. Everything else is user-owned and
 * safe to refine in place.
 */
export type SkillOrigin = 'bundled' | 'custom' | 'workspace' | 'external'

export interface SkillCatalogEntry extends SkillSummary {
  directoryPath: string
  skillFilePath: string
  autoEnabled?: boolean
  origin?: SkillOrigin
}

export interface SubagentProfile {
  id: string
  name: string
  enabled: boolean
  description: string
  command: string
  args: string[]
  env: Record<string, string>
  showInChatPicker?: boolean
  allowDelegation?: boolean
  allowDirectChat?: boolean
}

export interface FileMentionCandidate {
  path: string
  includeIgnored?: boolean
  kind?: 'jotdown'
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

export interface QQBotChannelConfig {
  /** Whether the QQ Official Bot is active. */
  enabled: boolean
  /** QQ Official Bot appId from the Developer Portal. */
  appId: string
  /** QQ Official Bot clientSecret. Stored in channels.toml, never in config.toml. */
  clientSecret: string
  /** Optional model override for QQBot threads. */
  model?: ThreadModelOverride
}

export interface ImageToTextConfig {
  /** When true, images in group messages are pre-described as alt text. Default false. */
  enabled?: boolean
}

export interface ChannelsConfig {
  telegram?: TelegramChannelConfig
  qq?: QQChannelConfig
  discord?: DiscordChannelConfig
  qqbot?: QQBotChannelConfig
  /** Keywords to redact from memory search results in guest conversations. */
  memoryFilterKeywords?: string[]
  /** Custom instruction injected into the system prompt for guest conversations. */
  guestInstruction?: string
  /** Image-to-text description service settings. */
  imageToText?: ImageToTextConfig
  /**
   * Global speech throttle verbosity for group discussions.
   * 0 = default throttle curve, 1 = never throttled. Default undefined (= 0).
   */
  groupVerbosity?: number
  /**
   * Global override for the active-phase check interval (ms).
   * Overridden by per-platform `activeCheckIntervalMs` when set.
   */
  groupCheckIntervalMs?: number
  /**
   * Legacy-named DM context budget (in K), currently shown in channel status output.
   * Default: 64 (= 64 000 tokens).
   */
  dmCompactTokenThresholdK?: number
  /**
   * Token budget (in K) for the group probe sliding window.
   * Default: 64 (= 64 000 tokens).
   */
  groupContextWindowK?: number
}

// ---------------------------------------------------------------------------
// Essentials (preset thread launchers)
// ---------------------------------------------------------------------------

export interface EssentialPreset {
  id: string
  icon: string
  iconType: 'emoji' | 'image'
  label?: string
  workspacePath?: string
  privacyMode?: boolean
  modelOverride?: ThreadModelOverride
  order: number
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
  essentials?: EssentialPreset[]
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

export type FolderColorTag = 'coral' | 'azure' | 'emerald' | 'amethyst' | 'slate'

export interface FolderRecord {
  id: string
  title: string
  colorTag: FolderColorTag | null
  createdAt: string
  updatedAt: string
}

export interface BootstrapPayload {
  threads: ThreadRecord[]
  archivedThreads: ThreadRecord[]
  folders: FolderRecord[]
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
  cacheReadTokens?: number
  cacheWriteTokens?: number
  modelId?: string
  providerName?: string
  /** Number of files changed in this run's snapshot (0 or absent = no snapshot). */
  snapshotFileCount?: number
  /** Workspace path used for this run's snapshot. */
  workspacePath?: string
}

// ---------------------------------------------------------------------------
// Usage Statistics
// ---------------------------------------------------------------------------

export type UsageStatsPeriod = 'day' | 'week' | 'month' | 'year'

export interface UsageStatsBucket {
  periodStart: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  /** Prompt tokens from runs that reported cache data (non-NULL cache_read_tokens). */
  cacheAwarePromptTokens: number
  runCount: number
}

export interface UsageStatsByModel {
  modelId: string
  providerName: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  cacheAwarePromptTokens: number
  runCount: number
}

export interface UsageStatsByWorkspace {
  workspacePath: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  cacheAwarePromptTokens: number
  runCount: number
}

export interface UsageStatsInput {
  period: UsageStatsPeriod
  from?: string
  to?: string
  /** Filter to a specific workspace. Use `'__null__'` to match threads with no workspace. */
  workspacePath?: string
  modelId?: string
  providerName?: string
}

export interface UsageStatsResponse {
  buckets: UsageStatsBucket[]
  byModel: UsageStatsByModel[]
  byWorkspace: UsageStatsByWorkspace[]
  totals: {
    promptTokens: number
    completionTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cacheAwarePromptTokens: number
    runCount: number
  }
}

export interface ChatAcceptedWithUserMessage {
  /** @deprecated 'active-run-steer' is no longer produced — steers are always pending until the turn boundary. */
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
  /**
   * Optional extra tools merged into the agent tool set for this run only.
   * Used by schedule service to inject `reportScheduleResult` without
   * polluting the core tool registry.
   */
  extraTools?: Record<string, unknown>
}

export interface AnswerToolQuestionInput {
  threadId: string
  runId: string
  toolCallId: string
  answer: string
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
  role?: 'user' | 'assistant'
  createdAt?: string
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
  requestMessageId?: string
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
  delegationId: string
  agentName: string
  workspacePath: string
}

export interface SubagentFinishedEvent extends RunEvent {
  type: 'subagent.finished'
  delegationId: string
  agentName: string
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
  | HarnessStartedEvent
  | HarnessFinishedEvent
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

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface ScheduleRecord {
  id: string
  name: string
  /** Cron expression for recurring schedules. Exactly one of cronExpression or runAt must be set. */
  cronExpression?: string
  /** ISO datetime for one-off schedules. The schedule is disabled after it fires or is skipped. */
  runAt?: string
  prompt: string
  workspacePath?: string
  modelOverride?: ThreadModelOverride
  enabledTools?: ToolCallName[]
  enabled: boolean
  /** True for schedules shipped with Yachiyo. Bundled schedules can be disabled but not deleted. */
  bundled?: boolean
  createdAt: string
  updatedAt: string
}

export type ScheduleRunStatus = 'running' | 'completed' | 'failed' | 'skipped'
export type ScheduleResultStatus = 'success' | 'failure'

export interface ScheduleRunRecord {
  id: string
  scheduleId: string
  threadId?: string
  status: ScheduleRunStatus
  resultStatus?: ScheduleResultStatus
  resultSummary?: string
  error?: string
  promptTokens?: number
  completionTokens?: number
  startedAt: string
  completedAt?: string
}

export interface CreateScheduleInput {
  name: string
  /** Cron expression for recurring schedules. Exactly one of cronExpression or runAt must be provided. */
  cronExpression?: string
  /** ISO datetime for a one-off schedule. Exactly one of cronExpression or runAt must be provided. */
  runAt?: string
  prompt: string
  workspacePath?: string
  modelOverride?: ThreadModelOverride
  enabledTools?: ToolCallName[]
  enabled?: boolean
}

export interface UpdateScheduleInput {
  id: string
  name?: string
  /** Pass null to clear and switch to one-off mode (requires also setting runAt). */
  cronExpression?: string | null
  /** Pass null to clear and switch to recurring mode (requires also setting cronExpression). */
  runAt?: string | null
  prompt?: string
  workspacePath?: string | null
  modelOverride?: ThreadModelOverride | null
  enabledTools?: ToolCallName[] | null
  enabled?: boolean
}

// ── Translator ──────────────────────────────────────────────────────

export interface TranslateInput {
  text: string
  targetLanguage: string
}

export type TranslateResult =
  | { status: 'success'; translatedText: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string }

// ── Jotdown ──────────────────────────────────────────────────────────

export interface JotdownMeta {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
}

export interface JotdownFull extends JotdownMeta {
  content: string
}

export interface JotdownSaveInput {
  id: string
  content: string
}

// ── Performance Statistics ────────────────────────────────────────────

export interface EventLoopDelayStats {
  /** Minimum delay in milliseconds */
  min: number
  /** Maximum delay in milliseconds */
  max: number
  /** Mean delay in milliseconds */
  mean: number
  /** 50th percentile delay in milliseconds */
  p50: number
  /** 95th percentile delay in milliseconds */
  p95: number
  /** 99th percentile delay in milliseconds */
  p99: number
  /** Number of samples collected */
  samples: number
}

export interface RunPerfRecord {
  runId: string
  threadId: string
  /** Total run wall-clock duration in milliseconds */
  durationMs: number
  /** Number of recovery checkpoint writes */
  checkpointWriteCount: number
  /** Total time spent on checkpoint writes in milliseconds */
  checkpointWriteTotalMs: number
  /** Maximum single checkpoint write duration in milliseconds */
  checkpointWriteMaxMs: number
  /** Number of tool call DB writes (create + update) */
  toolCallWriteCount: number
  /** Total time spent on tool call writes in milliseconds */
  toolCallWriteTotalMs: number
  /** Number of delta events emitted to the renderer */
  deltaEventCount: number
  /** Number of reasoning delta events emitted */
  reasoningDeltaEventCount: number
  /** Total text characters streamed */
  textCharsStreamed: number
  /** Timestamp when the run completed */
  completedAt: string
}

export interface PerfStatsResponse {
  /** Event loop delay stats since last reset */
  eventLoop: EventLoopDelayStats
  /** Recent run performance records (most recent first, capped at 50) */
  recentRuns: RunPerfRecord[]
  /** Total IPC events emitted since app start */
  ipcEventCount: number
  /** IPC events emitted in the last 60 seconds */
  ipcEventsLast60s: number
  /** Breakdown of IPC events by type in the last 60 seconds */
  ipcEventsByType: Record<string, number>
  /** Number of currently active runs */
  activeRunCount: number
  /** Uptime of the server process in seconds */
  uptimeSeconds: number
}
