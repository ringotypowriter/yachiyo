import type { MessageRecord, ThreadRecord } from '../../shared/yachiyo/protocol'

export interface StoredThreadRow {
  id: string
  title: string
  preview: string | null
  archivedAt: string | null
  updatedAt: string
  createdAt: string
}

export interface StoredMessageRow {
  id: string
  threadId: string
  role: MessageRecord['role']
  content: string
  status: MessageRecord['status']
  createdAt: string
  modelId: string | null
  providerName: string | null
}

export interface BootstrapState {
  threads: ThreadRecord[]
  messagesByThread: Record<string, MessageRecord[]>
}

export interface StartRunInput {
  runId: string
  thread: ThreadRecord
  updatedThread: ThreadRecord
  userMessage: MessageRecord
  createdAt: string
}

export interface CompleteRunInput {
  runId: string
  threadId: string
  assistantMessage: MessageRecord
  preview: string
  updatedAt: string
}

export interface YachiyoStorage {
  close(): void
  bootstrap(): BootstrapState
  getThread(threadId: string): ThreadRecord | undefined
  createThread(input: { thread: ThreadRecord; createdAt: string }): void
  renameThread(input: { threadId: string; title: string; updatedAt: string }): void
  archiveThread(input: { threadId: string; archivedAt: string; updatedAt: string }): void
  startRun(input: StartRunInput): void
  completeRun(input: CompleteRunInput): void
  cancelRun(input: { runId: string; completedAt: string }): void
  failRun(input: { runId: string; completedAt: string; error: string }): void
  listThreadHistory(threadId: string): Array<Pick<MessageRecord, 'content' | 'role'>>
}

export function toThreadRecord(
  row: Pick<StoredThreadRow, 'id' | 'preview' | 'title' | 'updatedAt'>
): ThreadRecord {
  if (row.preview === null) {
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt
    }
  }

  return {
    id: row.id,
    preview: row.preview,
    title: row.title,
    updatedAt: row.updatedAt
  }
}

export function toMessageRecord(row: StoredMessageRow): MessageRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt,
    ...(row.modelId === null ? {} : { modelId: row.modelId }),
    ...(row.providerName === null ? {} : { providerName: row.providerName })
  }
}

export function groupMessagesByThread(messages: MessageRecord[]): Record<string, MessageRecord[]> {
  return Object.groupBy(messages, (message) => message.threadId) as Record<string, MessageRecord[]>
}
