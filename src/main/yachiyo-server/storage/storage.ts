import type {
  ChannelGroupRecord,
  ChannelGroupStatus,
  ChannelPlatform,
  FolderColorTag,
  FolderRecord,
  ChannelUserRecord,
  ChannelUserRole,
  ChannelUserStatus,
  GroupMessageEntry,
  MessageFileAttachment,
  MessageImageRecord,
  MessageRecord,
  MessageTurnContext,
  ThreadMemoryRecallState,
  MessageTextBlockRecord,
  RunRecord,
  ScheduleRecord,
  ScheduleResultStatus,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ThreadModelOverride,
  ThreadRuntimeBinding,
  ThreadRecord,
  ThreadSearchResult,
  ToolCallDetailsSnapshot,
  ToolCallName,
  ToolCallRecord,
  ToolCallStatus,
  UsageStatsInput,
  UsageStatsResponse
} from '../../../shared/yachiyo/protocol'
import {
  normalizeEnabledTools,
  normalizeSkillNames,
  withThreadCapabilities
} from '../../../shared/yachiyo/protocol.ts'
import { normalizeMessageImages } from '../../../shared/yachiyo/messageContent.ts'

export interface StoredThreadRow {
  id: string
  icon: string | null
  title: string
  memoryRecallState: string | null
  workspacePath: string | null
  preview: string | null
  branchFromThreadId: string | null
  branchFromMessageId: string | null
  handoffFromThreadId: string | null
  folderId: string | null
  queuedFollowUpMessageId: string | null
  queuedFollowUpEnabledTools: string | null
  queuedFollowUpEnabledSkillNames: string | null
  archivedAt: string | null
  savingStartedAt: string | null
  starredAt: string | null
  privacyMode: string | null
  modelOverride: string | null
  source: string | null
  channelUserId: string | null
  channelGroupId: string | null
  rollingSummary: string | null
  summaryWatermarkMessageId: string | null
  readAt: string | null
  createdFromEssentialId: string | null
  createdFromScheduleId: string | null
  runtimeBinding: string | null
  lastDelegatedSession: string | null
  recapText: string | null
  updatedAt: string
  createdAt: string
  headMessageId: string | null
}

export interface StoredMessageRow {
  id: string
  threadId: string
  parentMessageId: string | null
  role: MessageRecord['role']
  content: string
  textBlocks: string | null
  images: string | null
  attachments: string | null
  reasoning: string | null
  responseMessages: string | null
  turnContext: string | null
  visibleReply: string | null
  senderName: string | null
  senderExternalUserId: string | null
  hidden: boolean | null
  status: MessageRecord['status']
  createdAt: string
  modelId: string | null
  providerName: string | null
}

export interface BootstrapState {
  threads: ThreadRecord[]
  archivedThreads: ThreadRecord[]
  folders: FolderRecord[]
  messagesByThread: Record<string, MessageRecord[]>
  toolCallsByThread: Record<string, ToolCallRecord[]>
  latestRunsByThread: Record<string, RunRecord>
}

export interface StartRunInput {
  runId: string
  thread: ThreadRecord
  updatedThread: ThreadRecord
  requestMessageId?: string
  userMessage?: MessageRecord
  createdAt: string
}

export interface CompleteRunInput {
  runId: string
  updatedThread: ThreadRecord
  assistantMessage: MessageRecord
  promptTokens?: number
  completionTokens?: number
  totalPromptTokens?: number
  totalCompletionTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  modelId?: string
  providerName?: string
}

/** Optional token usage fields shared by cancel/fail run inputs. */
interface TerminalRunUsage {
  promptTokens?: number
  completionTokens?: number
  totalPromptTokens?: number
  totalCompletionTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface CancelRunInput extends TerminalRunUsage {
  runId: string
  completedAt: string
}

export interface FailRunInput extends TerminalRunUsage {
  runId: string
  completedAt: string
  error: string
}

export interface CreateThreadInput {
  thread: ThreadRecord
  createdAt: string
  messages?: MessageRecord[]
}

export interface DeleteMessagesInput {
  thread: ThreadRecord
  messageIds: string[]
}

export interface SaveThreadMessageInput {
  thread: ThreadRecord
  updatedThread: ThreadRecord
  message: MessageRecord
  replacedMessageId?: string
}

export interface PersistResponseMessagesRepairInput {
  messageId: string
  responseMessages: unknown[]
}

export interface StoredToolCallRow {
  id: string
  runId: string | null
  threadId: string
  requestMessageId: string | null
  assistantMessageId: string | null
  toolName: string
  status: ToolCallStatus
  inputSummary: string
  outputSummary: string | null
  cwd: string | null
  error: string | null
  details: string | null
  startedAt: string
  finishedAt: string | null
  stepIndex: number | null
  stepBudget: number | null
}

export interface StoredRunRow {
  id: string
  threadId: string
  requestMessageId: string | null
  assistantMessageId: string | null
  status: RunRecord['status']
  error: string | null
  createdAt: string
  completedAt: string | null
  promptTokens: number | null
  completionTokens: number | null
  totalPromptTokens: number | null
  totalCompletionTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  modelId: string | null
  providerName: string | null
  snapshotFileCount: number | null
  workspacePath: string | null
}

export interface RunRecoveryCheckpoint {
  runId: string
  threadId: string
  requestMessageId: string
  assistantMessageId: string
  content: string
  textBlocks?: MessageTextBlockRecord[]
  reasoning?: string
  responseMessages?: unknown[]
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  channelHint?: string
  updateHeadOnComplete: boolean
  createdAt: string
  updatedAt: string
  recoveryAttempts: number
  lastError?: string
}

export interface StoredRunRecoveryCheckpointRow {
  runId: string
  threadId: string
  requestMessageId: string
  assistantMessageId: string
  content: string
  textBlocks: string | null
  reasoning: string | null
  responseMessages: string | null
  enabledTools: string
  enabledSkillNames: string | null
  channelHint: string | null
  updateHeadOnComplete: string
  createdAt: string
  updatedAt: string
  recoveryAttempts: number
  lastError: string | null
}

export interface YachiyoStorage {
  close(): void
  flushBackgroundTasks?(): Promise<void>
  bootstrap(): BootstrapState
  recoverInterruptedRuns(input: { finishedAt: string; error: string }): void
  listRunRecoveryCheckpoints(): RunRecoveryCheckpoint[]
  getRunRecoveryCheckpoint(runId: string): RunRecoveryCheckpoint | undefined
  upsertRunRecoveryCheckpoint(checkpoint: RunRecoveryCheckpoint): void
  deleteRunRecoveryCheckpoint(runId: string): void
  getRun(runId: string): RunRecord | undefined
  getThread(threadId: string): ThreadRecord | undefined
  getArchivedThread(threadId: string): ThreadRecord | undefined
  getThreadCreatedAt(threadId: string): string | undefined
  createThread(input: CreateThreadInput): void
  renameThread(input: { threadId: string; title: string; updatedAt: string }): void
  setThreadIcon(input: { threadId: string; icon: string | null; updatedAt: string }): void
  starThread(input: { threadId: string; starredAt: string | null }): void
  archiveThread(input: {
    threadId: string
    archivedAt: string
    updatedAt: string
    readAt?: string | null
  }): void
  markThreadAsRead(input: { threadId: string; readAt: string }): void
  markThreadReviewed(input: { threadId: string; reviewedAt: string }): void
  restoreThread(input: { threadId: string; updatedAt: string }): void
  beginThreadSave(input: { threadId: string; savingStartedAt: string }): void
  clearThreadSave(input: { threadId: string }): void
  recoverInterruptedSaves(): string[]
  deleteThread(input: { threadId: string }): void
  resetThreadHistory(input: { threadId: string; updatedAt: string }): void
  resetThreadsHistory(input: { threadIds: string[]; updatedAt: string }): void
  resetChannelGroupThreadsHistory(input: { channelGroupId: string; updatedAt: string }): void
  updateThread(thread: ThreadRecord): void
  setThreadPrivacyMode(input: { threadId: string; privacyMode: boolean; updatedAt: string }): void
  saveThreadMessage(input: SaveThreadMessageInput): void
  startRun(input: StartRunInput): void
  completeRun(input: CompleteRunInput): void
  cancelRun(input: CancelRunInput): void
  failRun(input: FailRunInput): void
  updateRunSnapshot(runId: string, snapshot: { fileCount: number; workspacePath?: string }): void
  listThreadRuns(threadId: string): RunRecord[]
  listThreadMessages(threadId: string): MessageRecord[]
  updateMessage(message: MessageRecord): void
  persistResponseMessagesRepairInBackground?(input: PersistResponseMessagesRepairInput): void
  listThreadToolCalls(threadId: string): ToolCallRecord[]
  createToolCall(toolCall: ToolCallRecord): void
  updateToolCall(toolCall: ToolCallRecord): void
  deleteMessages(input: DeleteMessagesInput): void
  searchThreadsAndMessages(input: { query: string }): ThreadSearchResult[]
  searchThreadsAndMessagesFts(input: {
    query: string
    limit?: number
    includePrivate?: boolean
  }): ThreadSearchResult[]
  listExternalThreads(): ThreadRecord[]
  findActiveChannelThread(channelUserId: string, maxAgeMs: number): ThreadRecord | undefined
  getThreadTotalTokens(threadId: string): number
  listChannelUsers(): ChannelUserRecord[]
  findChannelUser(platform: ChannelPlatform, externalUserId: string): ChannelUserRecord | undefined
  createChannelUser(user: Omit<ChannelUserRecord, 'usedKTokens'>): ChannelUserRecord
  getChannelUser(id: string): ChannelUserRecord | undefined
  updateChannelUser(input: {
    id: string
    status?: ChannelUserStatus
    role?: ChannelUserRole
    label?: string
    usageLimitKTokens?: number | null
    usedKTokens?: number
  }): ChannelUserRecord | undefined

  // Channel groups (group discussion mode)
  listChannelGroups(): ChannelGroupRecord[]
  findChannelGroup(
    platform: ChannelPlatform,
    externalGroupId: string
  ): ChannelGroupRecord | undefined
  getChannelGroup(id: string): ChannelGroupRecord | undefined
  createChannelGroup(group: Omit<ChannelGroupRecord, 'createdAt'>): ChannelGroupRecord
  updateChannelGroup(input: {
    id: string
    status?: ChannelGroupStatus
    name?: string
    label?: string
  }): ChannelGroupRecord | undefined
  findActiveGroupThread(channelGroupId: string, maxAgeMs: number): ThreadRecord | undefined
  listThreadsByChannelGroupId(channelGroupId: string): ThreadRecord[]

  // Thread folders
  listFolders(): FolderRecord[]
  getFolder(folderId: string): FolderRecord | undefined
  createFolder(folder: FolderRecord): void
  renameFolder(input: { folderId: string; title: string; updatedAt: string }): void
  setFolderColor(input: {
    folderId: string
    colorTag: FolderColorTag | null
    updatedAt: string
  }): void
  deleteFolder(folderId: string): void
  setThreadFolder(input: { threadId: string; folderId: string | null; updatedAt: string }): void

  // Image alt text cache
  getImageAltText(imageHash: string): { imageHash: string; altText: string } | undefined
  saveImageAltText(imageHash: string, altText: string): void

  // Schedules
  listSchedules(): ScheduleRecord[]
  getSchedule(id: string): ScheduleRecord | undefined
  createSchedule(schedule: ScheduleRecord): void
  updateSchedule(schedule: ScheduleRecord): void
  deleteSchedule(id: string): void

  // Schedule runs
  createScheduleRun(run: ScheduleRunRecord): void
  completeScheduleRun(input: {
    id: string
    status: ScheduleRunStatus
    threadId?: string
    resultStatus?: ScheduleResultStatus
    resultSummary?: string
    error?: string
    completedAt: string
    promptTokens?: number
    completionTokens?: number
  }): void
  listScheduleRuns(scheduleId: string, limit?: number): ScheduleRunRecord[]
  listRecentScheduleRuns(limit?: number): ScheduleRunRecord[]
  getScheduleRunByThreadId(threadId: string): ScheduleRunRecord | undefined
  recoverInterruptedScheduleRuns(input: { completedAt: string; error: string }): void

  // Usage statistics
  getUsageStats(input: UsageStatsInput): UsageStatsResponse

  // Group monitor buffer persistence
  saveGroupMonitorBuffer(input: {
    groupId: string
    phase: string
    buffer: GroupMessageEntry[]
    savedAt: string
  }): void
  loadGroupMonitorBuffer(
    groupId: string
  ): { phase: string; buffer: GroupMessageEntry[]; savedAt: string } | undefined
  deleteGroupMonitorBuffer(groupId: string): void
}

export function toThreadRecord(
  row: Pick<
    StoredThreadRow,
    | 'branchFromMessageId'
    | 'branchFromThreadId'
    | 'handoffFromThreadId'
    | 'folderId'
    | 'archivedAt'
    | 'starredAt'
    | 'headMessageId'
    | 'icon'
    | 'id'
    | 'memoryRecallState'
    | 'modelOverride'
    | 'preview'
    | 'privacyMode'
    | 'queuedFollowUpEnabledTools'
    | 'queuedFollowUpEnabledSkillNames'
    | 'queuedFollowUpMessageId'
    | 'source'
    | 'channelUserId'
    | 'channelGroupId'
    | 'rollingSummary'
    | 'summaryWatermarkMessageId'
    | 'readAt'
    | 'createdFromEssentialId'
    | 'createdFromScheduleId'
    | 'runtimeBinding'
    | 'lastDelegatedSession'
    | 'recapText'
    | 'title'
    | 'updatedAt'
    | 'workspacePath'
  >
): ThreadRecord {
  const queuedFollowUpEnabledTools = parseEnabledTools(row.queuedFollowUpEnabledTools)
  const queuedFollowUpEnabledSkillNames = parseSkillNames(row.queuedFollowUpEnabledSkillNames)
  const memoryRecall = parseThreadMemoryRecallState(row.memoryRecallState)
  const modelOverride = parseModelOverride(row.modelOverride)
  const runtimeBinding = parseRuntimeBinding(row.runtimeBinding)
  const lastDelegatedSession = parseLastDelegatedSession(row.lastDelegatedSession)
  const source = parseThreadSource(row.source)

  if (row.preview === null) {
    return withThreadCapabilities({
      ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
      ...(row.starredAt === null ? {} : { starredAt: row.starredAt }),
      ...(row.branchFromMessageId === null ? {} : { branchFromMessageId: row.branchFromMessageId }),
      ...(row.branchFromThreadId === null ? {} : { branchFromThreadId: row.branchFromThreadId }),
      ...(row.handoffFromThreadId === null ? {} : { handoffFromThreadId: row.handoffFromThreadId }),
      ...(row.folderId === null ? {} : { folderId: row.folderId }),
      ...(row.headMessageId === null ? {} : { headMessageId: row.headMessageId }),
      ...(row.icon === null ? {} : { icon: row.icon }),
      ...(memoryRecall ? { memoryRecall } : {}),
      ...(modelOverride ? { modelOverride } : {}),
      ...(row.privacyMode === '1' ? { privacyMode: true } : {}),
      ...(queuedFollowUpEnabledTools ? { queuedFollowUpEnabledTools } : {}),
      ...(queuedFollowUpEnabledSkillNames ? { queuedFollowUpEnabledSkillNames } : {}),
      ...(row.queuedFollowUpMessageId === null
        ? {}
        : { queuedFollowUpMessageId: row.queuedFollowUpMessageId }),
      ...(row.workspacePath === null ? {} : { workspacePath: row.workspacePath }),
      ...(source ? { source } : {}),
      ...(row.channelUserId === null ? {} : { channelUserId: row.channelUserId }),
      ...(row.channelGroupId === null ? {} : { channelGroupId: row.channelGroupId }),
      ...(row.rollingSummary === null ? {} : { rollingSummary: row.rollingSummary }),
      ...(row.summaryWatermarkMessageId === null
        ? {}
        : { summaryWatermarkMessageId: row.summaryWatermarkMessageId }),
      ...(row.readAt === null ? {} : { readAt: row.readAt }),
      ...(row.createdFromEssentialId === null
        ? {}
        : { createdFromEssentialId: row.createdFromEssentialId }),
      ...(row.createdFromScheduleId === null
        ? {}
        : { createdFromScheduleId: row.createdFromScheduleId }),
      ...(runtimeBinding ? { runtimeBinding } : {}),
      ...(lastDelegatedSession ? { lastDelegatedSession } : {}),
      ...(row.recapText === null ? {} : { recapText: row.recapText }),
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt
    })
  }

  return withThreadCapabilities({
    ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
    ...(row.starredAt === null ? {} : { starredAt: row.starredAt }),
    ...(row.branchFromMessageId === null ? {} : { branchFromMessageId: row.branchFromMessageId }),
    ...(row.branchFromThreadId === null ? {} : { branchFromThreadId: row.branchFromThreadId }),
    ...(row.handoffFromThreadId === null ? {} : { handoffFromThreadId: row.handoffFromThreadId }),
    ...(row.folderId === null ? {} : { folderId: row.folderId }),
    ...(row.headMessageId === null ? {} : { headMessageId: row.headMessageId }),
    ...(row.icon === null ? {} : { icon: row.icon }),
    ...(memoryRecall ? { memoryRecall } : {}),
    ...(modelOverride ? { modelOverride } : {}),
    ...(row.privacyMode === '1' ? { privacyMode: true } : {}),
    ...(queuedFollowUpEnabledTools ? { queuedFollowUpEnabledTools } : {}),
    ...(queuedFollowUpEnabledSkillNames ? { queuedFollowUpEnabledSkillNames } : {}),
    ...(row.queuedFollowUpMessageId === null
      ? {}
      : { queuedFollowUpMessageId: row.queuedFollowUpMessageId }),
    ...(row.workspacePath === null ? {} : { workspacePath: row.workspacePath }),
    ...(source ? { source } : {}),
    ...(row.channelUserId === null ? {} : { channelUserId: row.channelUserId }),
    ...(row.rollingSummary === null ? {} : { rollingSummary: row.rollingSummary }),
    ...(row.summaryWatermarkMessageId === null
      ? {}
      : { summaryWatermarkMessageId: row.summaryWatermarkMessageId }),
    ...(row.readAt === null ? {} : { readAt: row.readAt }),
    ...(row.createdFromScheduleId === null
      ? {}
      : { createdFromScheduleId: row.createdFromScheduleId }),
    ...(runtimeBinding ? { runtimeBinding } : {}),
    ...(lastDelegatedSession ? { lastDelegatedSession } : {}),
    ...(row.recapText === null ? {} : { recapText: row.recapText }),
    id: row.id,
    preview: row.preview,
    title: row.title,
    updatedAt: row.updatedAt
  })
}

export function serializeModelOverride(modelOverride?: ThreadModelOverride): string | null {
  return modelOverride ? JSON.stringify(modelOverride) : null
}

export function serializeRuntimeBinding(binding?: ThreadRuntimeBinding): string | null {
  return binding ? JSON.stringify(binding) : null
}

export function parseModelOverride(value: string | null): ThreadModelOverride | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (typeof parsed.providerName === 'string' && typeof parsed.model === 'string') {
      const providerName = parsed.providerName.trim()
      const model = parsed.model.trim()
      if (providerName && model) return { providerName, model }
    }
    return undefined
  } catch {
    return undefined
  }
}

export function parseRuntimeBinding(value: string | null): ThreadRuntimeBinding | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as ThreadRuntimeBinding
    if (parsed.kind !== 'llm' && parsed.kind !== 'acp') return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function serializeLastDelegatedSession(
  session: ThreadRecord['lastDelegatedSession']
): string | null {
  return session ? JSON.stringify(session) : null
}

export function parseLastDelegatedSession(
  value: string | null
): ThreadRecord['lastDelegatedSession'] {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (
      typeof parsed.agentName === 'string' &&
      typeof parsed.sessionId === 'string' &&
      typeof parsed.workspacePath === 'string' &&
      typeof parsed.timestamp === 'string'
    ) {
      return {
        agentName: parsed.agentName,
        sessionId: parsed.sessionId,
        workspacePath: parsed.workspacePath,
        timestamp: parsed.timestamp
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

export function toMessageRecord(row: StoredMessageRow): MessageRecord {
  const images = parseMessageImages(row.images)
  const attachments = parseMessageAttachments(row.attachments)
  const textBlocks = parseMessageTextBlocks(row.textBlocks)
  const responseMessages = parseResponseMessages(row.responseMessages)
  const turnContext = parseTurnContext(row.turnContext)

  return {
    id: row.id,
    threadId: row.threadId,
    ...(row.parentMessageId === null ? {} : { parentMessageId: row.parentMessageId }),
    role: row.role,
    content: row.content,
    ...(textBlocks ? { textBlocks } : {}),
    ...(images ? { images } : {}),
    ...(attachments ? { attachments } : {}),
    ...(row.reasoning ? { reasoning: row.reasoning } : {}),
    ...(responseMessages ? { responseMessages } : {}),
    ...(turnContext ? { turnContext } : {}),
    ...(row.visibleReply === null ? {} : { visibleReply: row.visibleReply }),
    ...(row.senderName === null ? {} : { senderName: row.senderName }),
    ...(row.senderExternalUserId === null
      ? {}
      : { senderExternalUserId: row.senderExternalUserId }),
    ...(row.hidden ? { hidden: true } : {}),
    status: row.status,
    createdAt: row.createdAt,
    ...(row.modelId === null ? {} : { modelId: row.modelId }),
    ...(row.providerName === null ? {} : { providerName: row.providerName })
  }
}

export function toToolCallRecord(row: StoredToolCallRow): ToolCallRecord {
  const details = parseToolCallDetails(row.details)

  return {
    ...(row.assistantMessageId === null ? {} : { assistantMessageId: row.assistantMessageId }),
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(details ? { details } : {}),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
    ...(row.outputSummary === null ? {} : { outputSummary: row.outputSummary }),
    id: row.id,
    inputSummary: row.inputSummary,
    ...(row.requestMessageId === null ? {} : { requestMessageId: row.requestMessageId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    startedAt: row.startedAt,
    ...(row.stepIndex === null ? {} : { stepIndex: row.stepIndex }),
    ...(row.stepBudget === null ? {} : { stepBudget: row.stepBudget }),
    status: row.status,
    threadId: row.threadId,
    toolName: row.toolName
  }
}

export function serializeToolCallDetails(details?: ToolCallDetailsSnapshot): string | null {
  return details ? JSON.stringify(details) : null
}

export function serializeEnabledTools(enabledTools?: readonly ToolCallName[]): string | null {
  return enabledTools ? JSON.stringify(normalizeEnabledTools(enabledTools)) : null
}

export function serializeSkillNames(skillNames?: readonly string[]): string | null {
  return skillNames ? JSON.stringify(normalizeSkillNames(skillNames)) : null
}

export function serializeThreadMemoryRecallState(state?: ThreadMemoryRecallState): string | null {
  if (!state) {
    return null
  }

  const recentInjections =
    state.recentInjections
      ?.filter(
        (entry) =>
          entry.memoryId.trim().length > 0 &&
          entry.fingerprint.trim().length > 0 &&
          entry.injectedAt.trim().length > 0 &&
          Number.isFinite(entry.messageCount) &&
          Number.isFinite(entry.charCount)
      )
      .map((entry) => ({
        ...entry,
        messageCount: Math.max(0, Math.trunc(entry.messageCount)),
        charCount: Math.max(0, Math.trunc(entry.charCount))
      })) ?? []

  const normalized: ThreadMemoryRecallState = {
    ...(state.lastRunAt?.trim() ? { lastRunAt: state.lastRunAt.trim() } : {}),
    ...(state.lastRecallAt?.trim() ? { lastRecallAt: state.lastRecallAt.trim() } : {}),
    ...(Number.isFinite(state.lastRecallMessageCount)
      ? { lastRecallMessageCount: Math.max(0, Math.trunc(state.lastRecallMessageCount ?? 0)) }
      : {}),
    ...(Number.isFinite(state.lastRecallCharCount)
      ? { lastRecallCharCount: Math.max(0, Math.trunc(state.lastRecallCharCount ?? 0)) }
      : {}),
    ...(recentInjections.length > 0 ? { recentInjections } : {})
  }

  return Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : null
}

export function parseToolCallDetails(details: string | null): ToolCallDetailsSnapshot | undefined {
  if (!details) {
    return undefined
  }

  try {
    return JSON.parse(details) as ToolCallDetailsSnapshot
  } catch {
    return undefined
  }
}

function parseThreadSource(value: string | null): ThreadRecord['source'] | undefined {
  if (
    value === 'local' ||
    value === 'telegram' ||
    value === 'qq' ||
    value === 'discord' ||
    value === 'qqbot'
  )
    return value
  return undefined
}

export function parseEnabledTools(value: string | null): ToolCallName[] | undefined {
  if (value === null) {
    return undefined
  }

  try {
    return normalizeEnabledTools(JSON.parse(value))
  } catch {
    return undefined
  }
}

function parseSkillNames(value: string | null): string[] | undefined {
  if (!value) {
    return undefined
  }

  try {
    return normalizeSkillNames(JSON.parse(value))
  } catch {
    return undefined
  }
}

function parseThreadMemoryRecallState(value: string | null): ThreadMemoryRecallState | undefined {
  if (value === null) {
    return undefined
  }

  try {
    const parsed = JSON.parse(value) as ThreadMemoryRecallState
    const recentInjections =
      parsed.recentInjections
        ?.filter(
          (entry) =>
            typeof entry.memoryId === 'string' &&
            typeof entry.fingerprint === 'string' &&
            typeof entry.injectedAt === 'string' &&
            typeof entry.messageCount === 'number' &&
            typeof entry.charCount === 'number'
        )
        .map((entry) => ({
          ...entry,
          memoryId: entry.memoryId.trim(),
          fingerprint: entry.fingerprint.trim(),
          injectedAt: entry.injectedAt.trim(),
          messageCount: Math.max(0, Math.trunc(entry.messageCount)),
          charCount: Math.max(0, Math.trunc(entry.charCount))
        }))
        .filter(
          (entry) =>
            entry.memoryId.length > 0 && entry.fingerprint.length > 0 && entry.injectedAt.length > 0
        ) ?? []

    const normalized: ThreadMemoryRecallState = {
      ...(typeof parsed.lastRunAt === 'string' && parsed.lastRunAt.trim().length > 0
        ? { lastRunAt: parsed.lastRunAt.trim() }
        : {}),
      ...(typeof parsed.lastRecallAt === 'string' && parsed.lastRecallAt.trim().length > 0
        ? { lastRecallAt: parsed.lastRecallAt.trim() }
        : {}),
      ...(typeof parsed.lastRecallMessageCount === 'number'
        ? { lastRecallMessageCount: Math.max(0, Math.trunc(parsed.lastRecallMessageCount)) }
        : {}),
      ...(typeof parsed.lastRecallCharCount === 'number'
        ? { lastRecallCharCount: Math.max(0, Math.trunc(parsed.lastRecallCharCount)) }
        : {}),
      ...(recentInjections.length > 0 ? { recentInjections } : {})
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined
  } catch {
    return undefined
  }
}

export function toRunRecord(row: StoredRunRow): RunRecord {
  return {
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.requestMessageId === null ? {} : { requestMessageId: row.requestMessageId }),
    ...(row.promptTokens == null ? {} : { promptTokens: row.promptTokens }),
    ...(row.completionTokens == null ? {} : { completionTokens: row.completionTokens }),
    ...(row.totalPromptTokens == null ? {} : { totalPromptTokens: row.totalPromptTokens }),
    ...(row.totalCompletionTokens == null
      ? {}
      : { totalCompletionTokens: row.totalCompletionTokens }),
    ...(row.cacheReadTokens == null ? {} : { cacheReadTokens: row.cacheReadTokens }),
    ...(row.cacheWriteTokens == null ? {} : { cacheWriteTokens: row.cacheWriteTokens }),
    ...(row.modelId == null ? {} : { modelId: row.modelId }),
    ...(row.providerName == null ? {} : { providerName: row.providerName }),
    ...(row.snapshotFileCount == null ? {} : { snapshotFileCount: row.snapshotFileCount }),
    ...(row.workspacePath == null ? {} : { workspacePath: row.workspacePath }),
    createdAt: row.createdAt,
    id: row.id,
    status: row.status,
    threadId: row.threadId
  }
}

export function toRunRecoveryCheckpoint(
  row: StoredRunRecoveryCheckpointRow
): RunRecoveryCheckpoint {
  const textBlocks = parseMessageTextBlocks(row.textBlocks)
  const responseMessages = parseResponseMessages(row.responseMessages)
  const enabledTools = parseEnabledTools(row.enabledTools) ?? []
  const enabledSkillNames = parseSkillNames(row.enabledSkillNames)

  return {
    runId: row.runId,
    threadId: row.threadId,
    requestMessageId: row.requestMessageId,
    assistantMessageId: row.assistantMessageId,
    content: row.content,
    ...(textBlocks ? { textBlocks } : {}),
    ...(row.reasoning ? { reasoning: row.reasoning } : {}),
    ...(responseMessages ? { responseMessages } : {}),
    enabledTools,
    ...(enabledSkillNames ? { enabledSkillNames } : {}),
    ...(row.channelHint ? { channelHint: row.channelHint } : {}),
    updateHeadOnComplete: row.updateHeadOnComplete === '1',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    recoveryAttempts: row.recoveryAttempts,
    ...(row.lastError ? { lastError: row.lastError } : {})
  }
}

export function toStoredRunRecoveryCheckpointRow(
  checkpoint: RunRecoveryCheckpoint
): StoredRunRecoveryCheckpointRow {
  return {
    runId: checkpoint.runId,
    threadId: checkpoint.threadId,
    requestMessageId: checkpoint.requestMessageId,
    assistantMessageId: checkpoint.assistantMessageId,
    content: checkpoint.content,
    textBlocks: serializeMessageTextBlocks(checkpoint.textBlocks),
    reasoning: serializeReasoning(checkpoint.reasoning),
    responseMessages: serializeResponseMessages(checkpoint.responseMessages),
    enabledTools: JSON.stringify(checkpoint.enabledTools),
    enabledSkillNames: checkpoint.enabledSkillNames
      ? JSON.stringify(checkpoint.enabledSkillNames)
      : null,
    channelHint: checkpoint.channelHint ?? null,
    updateHeadOnComplete: checkpoint.updateHeadOnComplete ? '1' : '0',
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
    recoveryAttempts: checkpoint.recoveryAttempts,
    lastError: checkpoint.lastError ?? null
  }
}

export function serializeReasoning(reasoning?: string): string | null {
  return reasoning?.trim() ? reasoning : null
}

export function serializeResponseMessages(responseMessages?: unknown[]): string | null {
  return responseMessages && responseMessages.length > 0 ? JSON.stringify(responseMessages) : null
}

export function parseResponseMessages(value: string | null): unknown[] | undefined {
  if (!value) {
    return undefined
  }

  try {
    const parsed = JSON.parse(value) as unknown[]
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

export function serializeTurnContext(turnContext?: MessageTurnContext): string | null {
  if (!turnContext) {
    return null
  }

  const hasReminder = turnContext.reminder?.trim()
  const hasMemory = turnContext.memoryEntries && turnContext.memoryEntries.length > 0

  if (!hasReminder && !hasMemory) {
    return null
  }

  return JSON.stringify(turnContext)
}

export function parseTurnContext(value: string | null): MessageTurnContext | undefined {
  if (!value) {
    return undefined
  }

  try {
    const parsed = JSON.parse(value) as MessageTurnContext
    const hasReminder = typeof parsed.reminder === 'string' && parsed.reminder.trim().length > 0
    const hasMemory = Array.isArray(parsed.memoryEntries) && parsed.memoryEntries.length > 0
    if (!hasReminder && !hasMemory) {
      return undefined
    }
    return {
      ...(hasReminder ? { reminder: parsed.reminder } : {}),
      ...(hasMemory ? { memoryEntries: parsed.memoryEntries } : {})
    }
  } catch {
    return undefined
  }
}

export function serializeMessageImages(images?: MessageImageRecord[]): string | null {
  const normalized = normalizeMessageImages(images)
  return normalized.length > 0 ? JSON.stringify(normalized) : null
}

export function serializeMessageTextBlocks(textBlocks?: MessageTextBlockRecord[]): string | null {
  return textBlocks && textBlocks.length > 0 ? JSON.stringify(textBlocks) : null
}

export function parseMessageTextBlocks(
  textBlocks: string | null
): MessageTextBlockRecord[] | undefined {
  if (!textBlocks) {
    return undefined
  }

  try {
    const parsed = JSON.parse(textBlocks) as MessageTextBlockRecord[]
    return parsed.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

export function parseMessageImages(images: string | null): MessageImageRecord[] | undefined {
  if (!images) {
    return undefined
  }

  try {
    const parsed = JSON.parse(images) as MessageImageRecord[]
    const normalized = normalizeMessageImages(parsed)
    return normalized.length > 0 ? normalized : undefined
  } catch {
    return undefined
  }
}

export function serializeMessageAttachments(attachments?: MessageFileAttachment[]): string | null {
  return attachments && attachments.length > 0 ? JSON.stringify(attachments) : null
}

export function parseMessageAttachments(
  attachments: string | null
): MessageFileAttachment[] | undefined {
  if (!attachments) {
    return undefined
  }

  try {
    const parsed = JSON.parse(attachments) as MessageFileAttachment[]
    const valid = parsed.filter(
      (a) =>
        typeof a.filename === 'string' &&
        typeof a.mediaType === 'string' &&
        typeof a.workspacePath === 'string'
    )
    return valid.length > 0 ? valid : undefined
  } catch {
    return undefined
  }
}

export function groupMessagesByThread(messages: MessageRecord[]): Record<string, MessageRecord[]> {
  return Object.groupBy(messages, (message) => message.threadId) as Record<string, MessageRecord[]>
}

export function groupToolCallsByThread(
  toolCalls: ToolCallRecord[]
): Record<string, ToolCallRecord[]> {
  return Object.groupBy(toolCalls, (toolCall) => toolCall.threadId) as Record<
    string,
    ToolCallRecord[]
  >
}

// ---------------------------------------------------------------------------
// Group monitor buffer serialization
// ---------------------------------------------------------------------------

/** Strip base64 image data but preserve alt text metadata for context continuity. */
export function serializeGroupMonitorBuffer(buffer: GroupMessageEntry[]): string {
  const stripped = buffer.map((entry) => {
    const images = entry.images
      ?.map((img) =>
        img.altText ? { dataUrl: '', mediaType: img.mediaType, altText: img.altText } : null
      )
      .filter((img) => img !== null)
    return {
      senderName: entry.senderName,
      senderExternalUserId: entry.senderExternalUserId,
      isMention: entry.isMention,
      text: entry.text,
      timestamp: entry.timestamp,
      ...(images && images.length > 0 ? { images } : {})
    }
  })
  return JSON.stringify(stripped)
}

export function parseGroupMonitorBuffer(value: string): GroupMessageEntry[] {
  try {
    const parsed = JSON.parse(value) as GroupMessageEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry) =>
        typeof entry.senderName === 'string' &&
        typeof entry.senderExternalUserId === 'string' &&
        typeof entry.text === 'string' &&
        typeof entry.timestamp === 'number'
    )
  } catch {
    return []
  }
}

export function groupLatestRunsByThread(runs: RunRecord[]): Record<string, RunRecord> {
  const latestRunsByThread: Record<string, RunRecord> = {}

  for (const run of runs) {
    if (!(run.threadId in latestRunsByThread)) {
      latestRunsByThread[run.threadId] = run
    }
  }

  return latestRunsByThread
}

// ---------------------------------------------------------------------------
// Schedule row ↔ record converters
// ---------------------------------------------------------------------------

export interface StoredScheduleRow {
  id: string
  name: string
  cronExpression: string | null
  runAt: string | null
  prompt: string
  workspacePath: string | null
  modelOverride: string | null
  enabledTools: string | null
  enabled: number
  createdAt: string
  updatedAt: string
}

export interface StoredScheduleRunRow {
  id: string
  scheduleId: string
  threadId: string | null
  status: ScheduleRunStatus
  resultStatus: string | null
  resultSummary: string | null
  error: string | null
  promptTokens: number | null
  completionTokens: number | null
  startedAt: string
  completedAt: string | null
}

export function toScheduleRecord(row: StoredScheduleRow): ScheduleRecord {
  const modelOverride = parseModelOverride(row.modelOverride)
  const enabledTools = parseEnabledTools(row.enabledTools)

  return {
    id: row.id,
    name: row.name,
    ...(row.cronExpression ? { cronExpression: row.cronExpression } : {}),
    ...(row.runAt ? { runAt: row.runAt } : {}),
    prompt: row.prompt,
    ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
    ...(modelOverride ? { modelOverride } : {}),
    ...(enabledTools ? { enabledTools } : {}),
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function toScheduleRunRecord(row: StoredScheduleRunRow): ScheduleRunRecord {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    ...(row.threadId ? { threadId: row.threadId } : {}),
    status: row.status,
    ...(row.resultStatus === 'success' || row.resultStatus === 'failure'
      ? { resultStatus: row.resultStatus }
      : {}),
    ...(row.resultSummary ? { resultSummary: row.resultSummary } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.promptTokens != null ? { promptTokens: row.promptTokens } : {}),
    ...(row.completionTokens != null ? { completionTokens: row.completionTokens } : {}),
    startedAt: row.startedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {})
  }
}
