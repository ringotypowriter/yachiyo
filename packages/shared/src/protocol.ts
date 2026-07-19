import type { AppLanguage, UpdateChannel } from './protocol/appPreferences.ts'
import type { ToolCallDetailsSnapshot } from './protocol/toolDetails.ts'
import type { TodoItemRecord } from './protocol/events.ts'
import type { ThingMentionResolution } from './protocol/things.ts'
import type { GroupProbeHeadlessAdapterConfig } from './protocol/groupProbeAdapters.ts'

export * from './protocol/appPreferences.ts'
export * from './protocol/toolDetails.ts'
export * from './protocol/usageStats.ts'
export * from './protocol/events.ts'
export * from './protocol/schedule.ts'
export * from './protocol/translate.ts'
export * from './protocol/jotdown.ts'
export * from './protocol/perf.ts'
export * from './protocol/things.ts'
export * from './protocol/groupProbeAdapters.ts'
export * from './protocol/browserAutomation.ts'

export type ChannelUserStatus = 'pending' | 'allowed' | 'blocked'
export type ChannelUserRole = 'owner' | 'guest'
export type ChannelPlatform = 'telegram' | 'qq' | 'discord' | 'qqbot'
export type NotificationThreadTarget = 'thread' | 'archivedThread'

export interface ShowNotificationInput {
  title: string
  body?: string
  threadId?: string
  target?: NotificationThreadTarget
}

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
  /** True while async image-to-text enrichment is still in progress. */
  imageDescriptionPending?: boolean
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
  | 'openai-codex'
  | 'anthropic'
  | 'gemini'
  | 'vertex'
  | 'vercel-gateway'
export type ActiveRunEnterBehavior = 'enter-steers' | 'enter-queues-follow-up'
export type SidebarVisibility = 'expanded' | 'collapsed'
export const THEME_IDS = [
  'mizu',
  'sumi',
  'ume',
  'aoba',
  'mint',
  'fuji',
  'yamabuki',
  'gobyou',
  'murasaki'
] as const
export type ThemeId = (typeof THEME_IDS)[number]
export type ThemeAppearance = 'system' | 'light' | 'dark'
export type SendChatMode = 'normal' | 'steer' | 'follow-up'
export type SendChatRunTrigger = 'local' | 'channel'
export type ToolModelMode = 'disabled' | 'default' | 'custom'
export type WebReadRequestFormat = 'markdown' | 'html'
export type WebReadContentFormat = WebReadRequestFormat | 'raw'
export type WebReadExtractor = 'defuddle' | 'linkedom-fallback' | 'none'
export type WebSearchProviderId = 'google-browser' | 'duckduckgo-browser' | 'exa'
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

export const DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD = 230_400
export const DEFAULT_WEB_READ_CONTENT_FORMAT: WebReadRequestFormat = 'markdown'
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
  'useBrowser',
  'webSearch',
  'skillsRead',
  'applyPatch',
  'useSentinel',
  'askUser',
  'delegateTask',
  'remember',
  'querySource',
  'useThings',
  'reviewThings',
  'updateProfile',
  'updateTodoList',
  'exitPlanMode'
] as const
export type ToolCallName = (typeof CORE_TOOL_NAMES)[number]
export type SelectableRunModeId = 'auto' | 'explore' | 'plan' | 'chat'
export type RunModeId = SelectableRunModeId | 'custom'
export type ToolCallStatus =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting-for-user'
  | 'background'

export type SubagentRuntimeMode = 'worker' | 'acp'
export type NamedSubagentId = 'explore' | 'plan' | 'review' | 'general'

const coreToolNameSet = new Set<string>(CORE_TOOL_NAMES)
const themeIdSet = new Set<string>(THEME_IDS)
const runtimeManagedToolNameSet = new Set<ToolCallName>(['skillsRead', 'reviewThings'])
const userManagedToolNames = CORE_TOOL_NAMES.filter(
  (toolName) => !runtimeManagedToolNameSet.has(toolName)
)

export const USER_MANAGED_TOOL_NAMES = [...userManagedToolNames] as ToolCallName[]
const defaultDisabledToolNameSet = new Set<ToolCallName>()
export const DEFAULT_ENABLED_TOOL_NAMES = USER_MANAGED_TOOL_NAMES.filter(
  (name) => !defaultDisabledToolNameSet.has(name)
) as ToolCallName[]
export const DEFAULT_RUN_MODE_ID: SelectableRunModeId = 'auto'
export const DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR: ActiveRunEnterBehavior = 'enter-steers'
export const DEFAULT_SIDEBAR_VISIBILITY: SidebarVisibility = 'expanded'
export const DEFAULT_THEME_ID: ThemeId = 'mizu'
export const DEFAULT_THEME_APPEARANCE: ThemeAppearance = 'system'
export const DEFAULT_TOOL_MODEL_MODE: ToolModelMode = 'default'

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
  ...CORE_TOOL_NAMES.filter((name) => name !== 'updateTodoList'),
  'askUser',
  'delegateTask',
  'remember',
  'querySource',
  'useThings',
  'reviewThings',
  'updateProfile',
  'useSentinel',
  'exitPlanMode'
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

export function normalizeThemeId(value: unknown, fallback: ThemeId = DEFAULT_THEME_ID): ThemeId {
  return typeof value === 'string' && themeIdSet.has(value) ? (value as ThemeId) : fallback
}

export function normalizeThemeAppearance(
  value: unknown,
  fallback: ThemeAppearance = DEFAULT_THEME_APPEARANCE
): ThemeAppearance {
  return value === 'system' || value === 'light' || value === 'dark' ? value : fallback
}

export function normalizeToolModelMode(
  value: unknown,
  fallback: ToolModelMode = DEFAULT_TOOL_MODEL_MODE
): ToolModelMode {
  return value === 'disabled' || value === 'default' || value === 'custom' ? value : fallback
}

export interface MessageImageRecord {
  dataUrl: string
  mediaType: string
  filename?: string
  workspacePath?: string
  /** 1-based inbound attachment order, when the image came from an external attachment. */
  attachmentIndex?: number
  /** Pre-generated alt text description from the image-to-text service. */
  altText?: string
  /** Replay this image as alt text because the original turn used image-to-text. */
  replayAsText?: boolean
}

export interface MessageFileAttachment {
  filename: string
  mediaType: string
  workspacePath: string
  /** 1-based inbound attachment order, when the file came from an external attachment. */
  attachmentIndex?: number
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

export type ThreadWorkspaceChangeBlockedReason = 'active-run' | 'acp-thread' | 'pending-plan'

export interface ThreadWorkspaceChangeDecision {
  allowed: boolean
  blockedReason?: ThreadWorkspaceChangeBlockedReason
  message?: string
  requiresConfirmation: boolean
  currentWorkspacePath: string
  targetWorkspacePath: string
}

export interface ThreadWorkspaceUpdateInput {
  threadId: string
  workspacePath?: string | null
  confirmed?: boolean
}

export interface ThreadWorkspaceChangeDecisionInput {
  threadId: string
  workspacePath?: string | null
}

export interface ThreadCapabilities {
  canRetry: boolean
  canCreateBranch: boolean
  canSelectReplyBranch: boolean
  canEdit: boolean
  canDelete: boolean
}

export interface ThreadSentinelRecord {
  threadId: string
  goal: string
  stopCondition: string
  intervalMinutes: number
  updatedAt: string
  nextRunAt?: string
}

export interface ThreadRecord {
  archivedAt?: string
  starredAt?: string
  colorTag?: ThreadColorTag
  icon?: string
  id: string
  title: string
  updatedAt: string
  memoryRecall?: ThreadMemoryRecallState
  workspacePath?: string
  preview?: string
  headMessageId?: string
  enabledTools?: ToolCallName[]
  runMode?: RunModeId
  reasoningEffort?: ComposerReasoningSelection
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
  /** Context handoff summary covering the folded transcript prefix. */
  contextHandoffSummary?: string
  /** Messages up to this ID are covered by contextHandoffSummary. Transcript window starts after it. */
  contextHandoffWatermarkMessageId?: string
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
  /** Current persistent todo widget snapshot for this thread. */
  todoItems?: TodoItemRecord[]
  recapText?: string
  /** Device that originally created this synced archive thread. Present only for remote read-only archives. */
  syncOriginDeviceId?: string
  syncImportedAt?: string
}

export function deriveThreadCapabilities(
  runtimeBinding?: ThreadRuntimeBinding,
  syncOriginDeviceId?: string
): ThreadCapabilities {
  const actionEnabled = runtimeBinding?.kind !== 'acp' && !syncOriginDeviceId

  return {
    canRetry: actionEnabled,
    canCreateBranch: actionEnabled,
    canSelectReplyBranch: actionEnabled,
    canEdit: actionEnabled,
    canDelete: actionEnabled
  }
}

export function getThreadCapabilities(
  thread: Pick<ThreadRecord, 'capabilities' | 'runtimeBinding' | 'syncOriginDeviceId'>
): ThreadCapabilities {
  return (
    thread.capabilities ??
    deriveThreadCapabilities(thread.runtimeBinding, thread.syncOriginDeviceId)
  )
}

export function withThreadCapabilities<T extends object>(
  thread: T & {
    runtimeBinding?: ThreadRuntimeBinding
    syncOriginDeviceId?: string
    capabilities?: ThreadCapabilities
  }
): Omit<T, 'capabilities'> & { capabilities: ThreadCapabilities } {
  return {
    ...thread,
    capabilities: deriveThreadCapabilities(thread.runtimeBinding, thread.syncOriginDeviceId)
  }
}

/** Per-turn injected context (reminder, memory) persisted for lossless replay. */
export interface MessageTurnContext {
  reminder?: string
  memoryEntries?: string[]
  activityText?: string
  enabledTools?: ToolCallName[]
  enabledSkillNames?: string[]
  runMode?: RunModeId
  thingMentions?: ThingMentionResolution[]
  /** Hidden user-message origin for timeline grouping. */
  hiddenRequestKind?: 'steer' | 'follow-up'
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
  /** Display-only raw tool input recovered from response messages when available. Not persisted as a storage column. */
  rawInput?: unknown
  /** Display-only raw tool output recovered from response messages when available. Not persisted as a storage column. */
  rawOutput?: unknown
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

export const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number]
export type ComposerReasoningSelection = 'off' | ReasoningEffortLevel

export interface ProviderReasoningModelConfig {
  model: string
  enabled?: boolean
  enabledEfforts?: ReasoningEffortLevel[]
  defaultEffort?: ComposerReasoningSelection
  allowOff?: boolean
}

export interface ProviderReasoningConfig {
  defaultEffort?: ComposerReasoningSelection
  models?: ProviderReasoningModelConfig[]
}

export interface ProviderConfig {
  id?: string
  /** Stable key linking this provider to a built-in preset (e.g. "openai", "google-vertex"). */
  presetKey?: string
  name: string
  type: ProviderKind
  thinkingEnabled?: boolean
  reasoning?: ProviderReasoningConfig
  // Used by openai, openai-responses, openai-codex, anthropic, gemini, vercel-gateway
  apiKey: string
  baseUrl: string
  // Path to Codex CLI auth.json for openai-codex OAuth login
  codexSessionPath?: string
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

export type ActivityTrackingMode = 'off' | 'simple' | 'full'

export interface ActivityOcrConfig {
  enabled: boolean
  excludedApps?: string[]
}

export interface ActivityTrackingConfig {
  mode: ActivityTrackingMode
  /** Whether the user has explicitly denied accessibility for full mode. */
  accessibilityDenied?: boolean
  ocr?: ActivityOcrConfig
}

export interface ActivitySourceEntry {
  appName: string
  bundleId: string
  windowTitle?: string
  durationMs: number
}

export type ActivitySnapshotTrigger = 'initial-blur' | 'long-session'
export type ActivitySnapshotSource = 'screen'
export type ActivitySnapshotDisplaySelection = 'window-overlap' | 'cursor' | 'primary'

export interface ActivitySnapshotRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ActivitySnapshotDisplay {
  displayId: number
  selection: ActivitySnapshotDisplaySelection
  bounds: ActivitySnapshotRect
  captureBounds?: ActivitySnapshotRect
}

export interface ActivityOcrSnapshot {
  engine: 'apple-vision'
  revision: number
  confidence: number
  lineCount: number
  contentHash: string
  excerpt: string
  text: string
}

export interface ActivitySnapshot {
  id: string
  capturedAt: string
  appName: string
  bundleId: string
  windowTitle?: string
  source: ActivitySnapshotSource
  trigger: ActivitySnapshotTrigger
  display?: ActivitySnapshotDisplay
  ocr?: ActivityOcrSnapshot
  error?: string
}

export interface ActivitySourceRecord {
  id: string
  threadId: string
  runId: string
  requestMessageId: string
  startedAt: string
  endedAt: string
  totalDurationMs: number
  uniqueApps: number
  afkDurationMs?: number
  summaryText: string
  entries: ActivitySourceEntry[]
  snapshots?: ActivitySnapshot[]
  createdAt: string
}

export interface ListActivitySourceRecordsInput {
  limit?: number
  offset?: number
}

export interface ListActivitySourceRecordsResult {
  records: ActivitySourceRecord[]
  totalCount: number
  limit: number
  offset: number
}

export interface GeneralConfig {
  sidebarVisibility?: SidebarVisibility
  language?: AppLanguage
  sidebarPreview?: boolean
  workSummary?: boolean
  themeId?: ThemeId
  themeAppearance?: ThemeAppearance
  uiFontSize?: number
  chatFontSize?: number
  chatPanelOpacity?: number
  updateChannel?: UpdateChannel
  demoMode?: boolean
  preventSystemSleep?: boolean
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

export interface SoulTraitRecord {
  key: string
  trait: string
}

export interface SoulDocument {
  filePath: string
  evolvedTraits: SoulTraitRecord[]
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
  activationCount?: number
  lastActivatedAt?: string
  updatedAt: string
}

export interface MemoryTermTopic {
  topic: string
  entryCount: number
  entries: MemoryTermEntry[]
}

export interface MemoryTermDocument {
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
  autoRecall?: boolean
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
  | 'things'
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

export interface SubagentsConfig {
  mode: SubagentRuntimeMode
  enabledNamedAgents: NamedSubagentId[]
  preferredModels?: Partial<Record<NamedSubagentId, ThreadModelOverride>>
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

export interface ResolveFileReferencesInput {
  workspacePath?: string | null
  references: string[]
}

export interface ResolvedFileReference {
  reference: string
  path: string
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
  /** Global override for the active-phase check interval (ms); per-platform `activeCheckIntervalMs` wins when set. */
  groupCheckIntervalMs?: number
  /** Legacy-named DM context budget (in K), shown in channel status output. Default: 64 (= 64 000 tokens). */
  dmCompactTokenThresholdK?: number
  /** Token budget (in K) for the group probe sliding window. Default: 64 (= 64 000 tokens). */
  groupContextWindowK?: number
  /** Raw group probe thread size (in K tokens) above which older transcript is summarized into a rolling handoff. Default & floor: 2× groupContextWindowK (hysteresis, so it doesn't re-summarize every turn). */
  groupHandoffThresholdK?: number
  /** Model that rewrites outgoing group replies into the persona's voice before sending. Unset = replies go out as generated (no rewrite pass). */
  groupRewriteModel?: ThreadModelOverride
  /** Hidden headless adapter option exposed only in per-platform group probe model selectors. */
  groupProbeAdapter?: GroupProbeHeadlessAdapterConfig
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
  runMode?: RunModeId
  general?: GeneralConfig
  chat?: ChatConfig
  workspace?: WorkspaceConfig
  sync?: { syncDir?: string }
  toolModel?: ToolModelConfig
  skills?: SkillsConfig
  memory?: MemoryConfig
  webSearch?: WebSearchConfig
  prompts?: UserPrompt[]
  subagentProfiles?: SubagentProfile[]
  essentials?: EssentialPreset[]
  subagents?: SubagentsConfig
}

export type SyncConflictResolution = 'keep_local' | 'use_remote' | 'merge'

/** A single setting that differs between this device and the synced device. */
export interface SyncSettingsFieldDiff {
  /** Dot path of the field, e.g. `general.themeId` or `providers`. */
  path: string
  /** Display value on this device, or null when the field is absent here. */
  localValue: string | null
  /** Display value from the synced device, or null when absent there. */
  remoteValue: string | null
}

export interface SyncConflictRecord {
  id: string
  opId: string
  deviceId: string
  entityType: string
  entityId: string
  localHash: string
  remoteHash: string
  payloadJson: string
  createdAt: string
  /** Field-level differences for settings conflicts; absent for other entity types. */
  settingsFields?: SyncSettingsFieldDiff[]
}

export type ListSyncConflictsResult = { conflicts: SyncConflictRecord[] }

export interface ResolveSyncConflictInput {
  conflictId: string
  resolution: SyncConflictResolution
  /** For `merge`: per-field choice keyed by `SyncSettingsFieldDiff.path`. Omitted fields keep local. */
  fieldSelections?: Record<string, 'local' | 'remote'>
}

export interface SyncStatus {
  state: 'sync_dir_unavailable' | 'not_initialized' | 'ready' | 'needs_attention'
  syncDir: string
  recommendedSyncDir: string
  deviceId?: string
  deviceCount: number
  pendingConflictCount: number
  lastExportedAt?: string
  lastImportedAt?: string
  lastError?: string
}

export function isMemoryConfigured(
  config: Pick<SettingsConfig, 'memory'> | null | undefined
): boolean {
  return config?.memory?.enabled === true
}

export interface ProviderSettings {
  providerName: string
  provider: ProviderKind
  model: string
  thinkingEnabled?: boolean
  reasoning?: ProviderReasoningConfig
  reasoningEffort?: ComposerReasoningSelection
  // Used by openai, openai-responses, openai-codex, anthropic, gemini, vercel-gateway
  apiKey: string
  baseUrl: string
  // Path to Codex CLI auth.json for openai-codex OAuth login
  codexSessionPath?: string
  // Populated at runtime from the Codex session file; not persisted in config.
  codexAccountId?: string
  // Used by vertex only
  project?: string
  location?: string
  serviceAccountEmail?: string
  serviceAccountPrivateKey?: string
}

export type ColorTag = 'coral' | 'azure' | 'emerald' | 'amethyst' | 'slate'
export type FolderColorTag = ColorTag
export type ThreadColorTag = ColorTag

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
  sentinelsByThread: Record<string, ThreadSentinelRecord>
  folders: FolderRecord[]
  messagesByThread: Record<string, MessageRecord[]>
  queuedFollowUpMessagesByThread: Record<string, MessageRecord[]>
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
  runMode?: RunModeId
  /** Number of files changed in this run's snapshot (0 or absent = no snapshot). */
  snapshotFileCount?: number
  /** Workspace path used for this run's snapshot. */
  workspacePath?: string
}

// ---------------------------------------------------------------------------
// Usage Statistics
// ---------------------------------------------------------------------------

export interface ChatAcceptedWithUserMessage {
  /** @deprecated 'active-run-steer' is no longer produced — steers are always pending until the turn boundary. */
  kind: 'run-started' | 'active-run-steer' | 'active-run-follow-up'
  thread: ThreadRecord
  userMessage: MessageRecord
  queuedFollowUpMessages?: MessageRecord[]
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
  runMode?: RunModeId
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
  /** 1-based inbound attachment order, preserved for model-facing attachment reminders. */
  attachmentIndex?: number
}

export interface SendChatInput {
  threadId: string
  content: string
  images?: MessageImageRecord[]
  attachments?: SendChatAttachment[]
  enabledSkillNames?: string[]
  runMode?: RunModeId
  /**
   * Optional previous mode to mention in the turn reminder when this request is
   * system-started from a mode transition, such as accepting a Plan Mode plan.
   */
  previousRunMode?: RunModeId
  reasoningEffort?: ComposerReasoningSelection
  mode?: SendChatMode
  runTrigger?: SendChatRunTrigger
  /**
   * Hide the submitted user message from the timeline while keeping it in model context.
   * Used for system-initiated delivery such as background task completion notices.
   */
  hidden?: boolean
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
  enabledSkillNames?: string[]
  runMode?: RunModeId
  reasoningEffort?: ComposerReasoningSelection
}

export interface EditMessageInput {
  threadId: string
  messageId: string
  content: string
  images?: MessageImageRecord[]
  attachments?: SendChatAttachment[]
  enabledSkillNames?: string[]
  runMode?: RunModeId
  reasoningEffort?: ComposerReasoningSelection
}

export interface CompactThreadInput {
  threadId: string
  reasoningEffort?: ComposerReasoningSelection
}

export interface SaveThreadInput {
  threadId: string
  archiveAfterSave?: boolean
}

export interface ReadThreadPlanDocumentInput {
  threadId: string
}

export interface ReadThreadPlanDocumentResult {
  path: string
  content: string
  decision?: 'pending' | 'rejected' | 'accepted'
}

export type AcceptThreadPlanDocumentMode = 'direct' | 'handoff'

export interface AcceptThreadPlanDocumentInput {
  threadId: string
  mode?: AcceptThreadPlanDocumentMode
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
  limit?: number
  offset?: number
}

export interface DeleteMemoryTermInput {
  id: string
}

export interface DeleteMemoryTermResult {
  deleted: boolean
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
  queuedFollowUpMessages?: MessageRecord[]
  toolCalls: ToolCallRecord[]
}

export interface ThreadSearchMessageMatch {
  messageId: string
  snippet: string
  role?: 'user' | 'assistant'
  createdAt?: string
}

export interface SearchThreadsAndMessagesInput {
  query: string
  scope?: 'active' | 'archived'
}

export interface ThreadSearchResult {
  threadId: string
  threadTitle: string
  threadUpdatedAt: string
  titleMatched: boolean
  messageMatches: ThreadSearchMessageMatch[]
}
