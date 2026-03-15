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
    close() {},

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

    createThread({ thread, createdAt }) {
      threads.set(thread.id, {
        id: thread.id,
        title: thread.title,
        preview: thread.preview ?? null,
        archivedAt: null,
        updatedAt: thread.updatedAt,
        createdAt
      })
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

    startRun({ runId, thread, updatedThread, userMessage, createdAt }: StartRunInput) {
      const storedThread = threads.get(thread.id)
      if (!storedThread) {
        return
      }

      storedThread.title = updatedThread.title
      storedThread.updatedAt = updatedThread.updatedAt
      messages.push(userMessage)
      runs.set(runId, {
        id: runId,
        threadId: thread.id,
        status: 'running',
        error: null,
        createdAt,
        completedAt: null
      })
    },

    completeRun({ runId, threadId, assistantMessage, preview, updatedAt }: CompleteRunInput) {
      const thread = threads.get(threadId)
      const run = runs.get(runId)

      messages.push(assistantMessage)

      if (thread) {
        thread.preview = preview
        thread.updatedAt = updatedAt
      }

      if (run) {
        run.status = 'completed'
        run.completedAt = updatedAt
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

    listThreadHistory(threadId) {
      return sortByCreatedAt(messages)
        .filter((message) => message.threadId === threadId)
        .map(({ content, role }) => ({ content, role }))
    }
  }
}
