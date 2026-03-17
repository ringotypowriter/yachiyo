import type {
  MessageImageRecord,
  MessageRecord,
  ThreadRecord,
  ToolCallName,
  ToolCallRecord,
  ToolCallStatus
} from '../../shared/yachiyo/protocol'
import { normalizeMessageImages } from '../../shared/yachiyo/messageContent.ts'

export interface StoredThreadRow {
  id: string
  title: string
  preview: string | null
  branchFromThreadId: string | null
  branchFromMessageId: string | null
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
  messagesByThread: Record<string, MessageRecord[]>
  toolCallsByThread: Record<string, ToolCallRecord[]>
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

export interface StoredToolCallRow {
  id: string
  runId: string
  threadId: string
  toolName: ToolCallName
  status: ToolCallStatus
  inputSummary: string
  outputSummary: string | null
  cwd: string | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export interface YachiyoStorage {
  close(): void
  bootstrap(): BootstrapState
  getThread(threadId: string): ThreadRecord | undefined
  createThread(input: CreateThreadInput): void
  renameThread(input: { threadId: string; title: string; updatedAt: string }): void
  archiveThread(input: { threadId: string; archivedAt: string; updatedAt: string }): void
  updateThread(thread: ThreadRecord): void
  startRun(input: StartRunInput): void
  completeRun(input: CompleteRunInput): void
  cancelRun(input: { runId: string; completedAt: string }): void
  failRun(input: { runId: string; completedAt: string; error: string }): void
  listThreadMessages(threadId: string): MessageRecord[]
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
    | 'headMessageId'
    | 'id'
    | 'preview'
    | 'title'
    | 'updatedAt'
  >
): ThreadRecord {
  if (row.preview === null) {
    return {
      ...(row.branchFromMessageId === null ? {} : { branchFromMessageId: row.branchFromMessageId }),
      ...(row.branchFromThreadId === null ? {} : { branchFromThreadId: row.branchFromThreadId }),
      ...(row.headMessageId === null ? {} : { headMessageId: row.headMessageId }),
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt
    }
  }

  return {
    ...(row.branchFromMessageId === null ? {} : { branchFromMessageId: row.branchFromMessageId }),
    ...(row.branchFromThreadId === null ? {} : { branchFromThreadId: row.branchFromThreadId }),
    ...(row.headMessageId === null ? {} : { headMessageId: row.headMessageId }),
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
  return {
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
    ...(row.outputSummary === null ? {} : { outputSummary: row.outputSummary }),
    id: row.id,
    inputSummary: row.inputSummary,
    runId: row.runId,
    startedAt: row.startedAt,
    status: row.status,
    threadId: row.threadId,
    toolName: row.toolName
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
