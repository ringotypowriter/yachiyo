import type {
  MessageImageRecord,
  MessageRecord,
  RunRecord,
  ThreadRecord,
  ToolCallDetailsSnapshot,
  ToolCallName,
  ToolCallRecord,
  ToolCallStatus
} from '../../../shared/yachiyo/protocol'
import { normalizeEnabledTools } from '../../../shared/yachiyo/protocol.ts'
import { normalizeMessageImages } from '../../../shared/yachiyo/messageContent.ts'

export interface StoredThreadRow {
  id: string
  title: string
  workspacePath: string | null
  preview: string | null
  branchFromThreadId: string | null
  branchFromMessageId: string | null
  queuedFollowUpMessageId: string | null
  queuedFollowUpEnabledTools: string | null
  archivedAt: string | null
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
  images: string | null
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
  requestMessageId: string
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
  archiveThread(input: { threadId: string; archivedAt: string; updatedAt: string }): void
  restoreThread(input: { threadId: string; updatedAt: string }): void
  deleteThread(input: { threadId: string }): void
  updateThread(thread: ThreadRecord): void
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
}

export function toThreadRecord(
  row: Pick<
    StoredThreadRow,
    | 'branchFromMessageId'
    | 'branchFromThreadId'
    | 'archivedAt'
    | 'headMessageId'
    | 'id'
    | 'preview'
    | 'queuedFollowUpEnabledTools'
    | 'queuedFollowUpMessageId'
    | 'title'
    | 'updatedAt'
    | 'workspacePath'
  >
): ThreadRecord {
  const queuedFollowUpEnabledTools = parseEnabledTools(row.queuedFollowUpEnabledTools)

  if (row.preview === null) {
    return {
      ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
      ...(row.branchFromMessageId === null ? {} : { branchFromMessageId: row.branchFromMessageId }),
      ...(row.branchFromThreadId === null ? {} : { branchFromThreadId: row.branchFromThreadId }),
      ...(row.headMessageId === null ? {} : { headMessageId: row.headMessageId }),
      ...(queuedFollowUpEnabledTools ? { queuedFollowUpEnabledTools } : {}),
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
    ...(row.branchFromMessageId === null ? {} : { branchFromMessageId: row.branchFromMessageId }),
    ...(row.branchFromThreadId === null ? {} : { branchFromThreadId: row.branchFromThreadId }),
    ...(row.headMessageId === null ? {} : { headMessageId: row.headMessageId }),
    ...(queuedFollowUpEnabledTools ? { queuedFollowUpEnabledTools } : {}),
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

  return {
    id: row.id,
    threadId: row.threadId,
    ...(row.parentMessageId === null ? {} : { parentMessageId: row.parentMessageId }),
    role: row.role,
    content: row.content,
    ...(images ? { images } : {}),
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

export function serializeMessageImages(images?: MessageImageRecord[]): string | null {
  const normalized = normalizeMessageImages(images)
  return normalized.length > 0 ? JSON.stringify(normalized) : null
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
