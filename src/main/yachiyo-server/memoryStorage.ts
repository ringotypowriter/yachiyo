import type { MessageRecord } from '../../shared/yachiyo/protocol'
import {
  groupMessagesByThread,
  toThreadRecord,
  type CompleteRunInput,
  type StartRunInput,
  type StoredThreadRow,
  type YachiyoStorage
} from './storage.ts'

interface StoredRunRow {
  id: string
  threadId: string
  requestMessageId: string | null
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  error: string | null
  createdAt: string
  completedAt: string | null
}

export function createInMemoryYachiyoStorage(): YachiyoStorage {
  const threads = new Map<string, StoredThreadRow>()
  const messages: MessageRecord[] = []
  const runs = new Map<string, StoredRunRow>()

  const readThread = (threadId: string): StoredThreadRow | undefined => {
    const thread = threads.get(threadId)
    if (!thread || thread.archivedAt !== null) {
      return undefined
    }
    return thread
  }

  const sortByCreatedAt = <T extends { createdAt: string }>(items: T[]): T[] =>
    [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt))

  return {
    close() {
      // In-memory storage does not hold external resources.
    },

    bootstrap() {
      const activeThreads = [...threads.values()]
        .filter((thread) => thread.archivedAt === null)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

      const threadIds = new Set(activeThreads.map((thread) => thread.id))
      const activeMessages = sortByCreatedAt(
        messages.filter((message) => threadIds.has(message.threadId))
      )

      return {
        threads: activeThreads.map(toThreadRecord),
        messagesByThread: groupMessagesByThread(activeMessages)
      }
    },

    getThread(threadId) {
      const thread = readThread(threadId)
      return thread ? toThreadRecord(thread) : undefined
    },

    createThread({ thread, createdAt, messages: initialMessages = [] }) {
      threads.set(thread.id, {
        id: thread.id,
        title: thread.title,
        preview: thread.preview ?? null,
        branchFromThreadId: thread.branchFromThreadId ?? null,
        branchFromMessageId: thread.branchFromMessageId ?? null,
        archivedAt: null,
        headMessageId: thread.headMessageId ?? null,
        updatedAt: thread.updatedAt,
        createdAt
      })
      messages.push(...initialMessages)
    },

    renameThread({ threadId, title, updatedAt }) {
      const thread = readThread(threadId)
      if (!thread) {
        return
      }

      thread.title = title
      thread.updatedAt = updatedAt
    },

    archiveThread({ threadId, archivedAt, updatedAt }) {
      const thread = readThread(threadId)
      if (!thread) {
        return
      }

      thread.archivedAt = archivedAt
      thread.updatedAt = updatedAt
    },

    updateThread(nextThread) {
      const storedThread = threads.get(nextThread.id)
      if (!storedThread || storedThread.archivedAt !== null) {
        return
      }

      storedThread.branchFromThreadId = nextThread.branchFromThreadId ?? null
      storedThread.branchFromMessageId = nextThread.branchFromMessageId ?? null
      storedThread.headMessageId = nextThread.headMessageId ?? null
      storedThread.preview = nextThread.preview ?? null
      storedThread.title = nextThread.title
      storedThread.updatedAt = nextThread.updatedAt
    },

    startRun({ runId, thread, updatedThread, requestMessageId, userMessage, createdAt }: StartRunInput) {
      const storedThread = threads.get(thread.id)
      if (!storedThread) {
        return
      }

      storedThread.title = updatedThread.title
      storedThread.updatedAt = updatedThread.updatedAt
      storedThread.headMessageId = updatedThread.headMessageId ?? null
      if (userMessage) {
        messages.push(userMessage)
      }
      runs.set(runId, {
        id: runId,
        requestMessageId,
        threadId: thread.id,
        status: 'running',
        error: null,
        createdAt,
        completedAt: null
      })
    },

    completeRun({ runId, updatedThread, assistantMessage }: CompleteRunInput) {
      const thread = threads.get(updatedThread.id)
      const run = runs.get(runId)

      messages.push(assistantMessage)

      if (thread) {
        thread.headMessageId = updatedThread.headMessageId ?? null
        thread.preview = updatedThread.preview ?? null
        thread.updatedAt = updatedThread.updatedAt
      }

      if (run) {
        run.status = 'completed'
        run.completedAt = updatedThread.updatedAt
      }
    },

    cancelRun({ runId, completedAt }) {
      const run = runs.get(runId)
      if (!run) {
        return
      }

      run.status = 'cancelled'
      run.completedAt = completedAt
    },

    failRun({ runId, completedAt, error }) {
      const run = runs.get(runId)
      if (!run) {
        return
      }

      run.status = 'failed'
      run.error = error
      run.completedAt = completedAt
    },

    listThreadMessages(threadId) {
      return sortByCreatedAt(messages)
        .filter((message) => message.threadId === threadId)
    },

    deleteMessages({ thread, messageIds }) {
      const deletedIds = new Set(messageIds)
      const nextMessages = messages.filter((message) => !deletedIds.has(message.id))
      messages.length = 0
      messages.push(...nextMessages)

      const storedThread = threads.get(thread.id)
      if (!storedThread) {
        return
      }

      storedThread.branchFromThreadId = thread.branchFromThreadId ?? null
      storedThread.branchFromMessageId = thread.branchFromMessageId ?? null
      storedThread.headMessageId = thread.headMessageId ?? null
      storedThread.preview = thread.preview ?? null
      storedThread.title = thread.title
      storedThread.updatedAt = thread.updatedAt
    }
  }
}
