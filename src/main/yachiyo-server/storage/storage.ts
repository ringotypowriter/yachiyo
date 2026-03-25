import type {
  MessageFileAttachment,
  MessageImageRecord,
  MessageRecord,
  ThreadMemoryRecallState,
  MessageTextBlockRecord,
  RunRecord,
  ThreadRecord,
  ThreadSearchResult,
  ToolCallDetailsSnapshot,
  ToolCallName,
  ToolCallRecord,
  ToolCallStatus
} from '../../../shared/yachiyo/protocol'
import { normalizeEnabledTools, normalizeSkillNames } from '../../../shared/yachiyo/protocol.ts'
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
  queuedFollowUpMessageId: string | null
  queuedFollowUpEnabledTools: string | null
  queuedFollowUpEnabledSkillNames: string | null
  archivedAt: string | null
  starredAt: string | null
  privacyMode: string | null
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
  status: MessageRecord['status']
  createdAt: string
  modelId: string | null
  providerName: string | null
}

export interface BootstrapState {
  threads: ThreadRecord[]
  archivedThreads: ThreadRecord[]
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

export interface StoredToolCallRow {
  id: string
  runId: string
  threadId: string
  requestMessageId: string | null
  assistantMessageId: string | null
  toolName: ToolCallName
  status: ToolCallStatus
  inputSummary: string
  outputSummary: string | null
  cwd: string | null
  error: string | null
  details: string | null
  startedAt: string
  finishedAt: string | null
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
}

export interface YachiyoStorage {
  close(): void
  bootstrap(): BootstrapState
  recoverInterruptedRuns(input: { finishedAt: string; error: string }): void
  getThread(threadId: string): ThreadRecord | undefined
  getArchivedThread(threadId: string): ThreadRecord | undefined
  getThreadCreatedAt(threadId: string): string | undefined
  createThread(input: CreateThreadInput): void
  renameThread(input: { threadId: string; title: string; updatedAt: string }): void
  setThreadIcon(input: { threadId: string; icon: string | null; updatedAt: string }): void
  starThread(input: { threadId: string; starredAt: string | null }): void
  archiveThread(input: { threadId: string; archivedAt: string; updatedAt: string }): void
  restoreThread(input: { threadId: string; updatedAt: string }): void
  deleteThread(input: { threadId: string }): void
  updateThread(thread: ThreadRecord): void
  setThreadPrivacyMode(input: { threadId: string; privacyMode: boolean; updatedAt: string }): void
  saveThreadMessage(input: SaveThreadMessageInput): void
  startRun(input: StartRunInput): void
  completeRun(input: CompleteRunInput): void
  cancelRun(input: { runId: string; completedAt: string }): void
  failRun(input: { runId: string; completedAt: string; error: string }): void
  listThreadMessages(threadId: string): MessageRecord[]
  updateMessage(message: MessageRecord): void
  listThreadToolCalls(threadId: string): ToolCallRecord[]
  createToolCall(toolCall: ToolCallRecord): void
  updateToolCall(toolCall: ToolCallRecord): void
  deleteMessages(input: DeleteMessagesInput): void
  searchThreadsAndMessages(input: { query: string }): ThreadSearchResult[]
}

export function toThreadRecord(
  row: Pick<
    StoredThreadRow,
    | 'branchFromMessageId'
    | 'branchFromThreadId'
    | 'archivedAt'
    | 'starredAt'
    | 'headMessageId'
    | 'icon'
    | 'id'
    | 'memoryRecallState'
    | 'preview'
    | 'privacyMode'
    | 'queuedFollowUpEnabledTools'
    | 'queuedFollowUpEnabledSkillNames'
    | 'queuedFollowUpMessageId'
    | 'title'
    | 'updatedAt'
    | 'workspacePath'
  >
): ThreadRecord {
  const queuedFollowUpEnabledTools = parseEnabledTools(row.queuedFollowUpEnabledTools)
  const queuedFollowUpEnabledSkillNames = parseSkillNames(row.queuedFollowUpEnabledSkillNames)
  const memoryRecall = parseThreadMemoryRecallState(row.memoryRecallState)

  if (row.preview === null) {
    return {
      ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
      ...(row.starredAt === null ? {} : { starredAt: row.starredAt }),
      ...(row.branchFromMessageId === null ? {} : { branchFromMessageId: row.branchFromMessageId }),
      ...(row.branchFromThreadId === null ? {} : { branchFromThreadId: row.branchFromThreadId }),
      ...(row.headMessageId === null ? {} : { headMessageId: row.headMessageId }),
      ...(row.icon === null ? {} : { icon: row.icon }),
      ...(memoryRecall ? { memoryRecall } : {}),
      ...(row.privacyMode === '1' ? { privacyMode: true } : {}),
      ...(queuedFollowUpEnabledTools ? { queuedFollowUpEnabledTools } : {}),
      ...(queuedFollowUpEnabledSkillNames ? { queuedFollowUpEnabledSkillNames } : {}),
      ...(row.queuedFollowUpMessageId === null
        ? {}
        : { queuedFollowUpMessageId: row.queuedFollowUpMessageId }),
      ...(row.workspacePath === null ? {} : { workspacePath: row.workspacePath }),
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt
    }
  }

  return {
    ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
    ...(row.starredAt === null ? {} : { starredAt: row.starredAt }),
    ...(row.branchFromMessageId === null ? {} : { branchFromMessageId: row.branchFromMessageId }),
    ...(row.branchFromThreadId === null ? {} : { branchFromThreadId: row.branchFromThreadId }),
    ...(row.headMessageId === null ? {} : { headMessageId: row.headMessageId }),
    ...(row.icon === null ? {} : { icon: row.icon }),
    ...(memoryRecall ? { memoryRecall } : {}),
    ...(row.privacyMode === '1' ? { privacyMode: true } : {}),
    ...(queuedFollowUpEnabledTools ? { queuedFollowUpEnabledTools } : {}),
    ...(queuedFollowUpEnabledSkillNames ? { queuedFollowUpEnabledSkillNames } : {}),
    ...(row.queuedFollowUpMessageId === null
      ? {}
      : { queuedFollowUpMessageId: row.queuedFollowUpMessageId }),
    ...(row.workspacePath === null ? {} : { workspacePath: row.workspacePath }),
    id: row.id,
    preview: row.preview,
    title: row.title,
    updatedAt: row.updatedAt
  }
}

export function toMessageRecord(row: StoredMessageRow): MessageRecord {
  const images = parseMessageImages(row.images)
  const attachments = parseMessageAttachments(row.attachments)
  const textBlocks = parseMessageTextBlocks(row.textBlocks)

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
    runId: row.runId,
    startedAt: row.startedAt,
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

function parseEnabledTools(value: string | null): ToolCallName[] | undefined {
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
    createdAt: row.createdAt,
    id: row.id,
    status: row.status,
    threadId: row.threadId
  }
}

export function serializeReasoning(reasoning?: string): string | null {
  return reasoning?.trim() ? reasoning : null
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

export function groupLatestRunsByThread(runs: RunRecord[]): Record<string, RunRecord> {
  const latestRunsByThread: Record<string, RunRecord> = {}

  for (const run of runs) {
    if (!(run.threadId in latestRunsByThread)) {
      latestRunsByThread[run.threadId] = run
    }
  }

  return latestRunsByThread
}
