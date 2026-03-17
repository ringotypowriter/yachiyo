import type { MessageRecord, ToolCallRecord } from '../../shared/yachiyo/protocol'
import {
  groupToolCallsByThread,
  groupMessagesByThread,
  toToolCallRecord,
  toThreadRecord,
  type CompleteRunInput,
  type StartRunInput,
  type StoredToolCallRow,
  type StoredThreadRow,
  type YachiyoStorage
} from './storage.ts'

interface StoredRunRow {
  id: string
  threadId: string
  requestMessageId: string | null
  assistantMessageId: string | null
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  error: string | null
  createdAt: string
  completedAt: string | null
}

export function createInMemoryYachiyoStorage(): YachiyoStorage {
  const threads = new Map<string, StoredThreadRow>()
  const messages: MessageRecord[] = []
  const runs = new Map<string, StoredRunRow>()
  const toolCalls = new Map<string, StoredToolCallRow>()

  const readThread = (threadId: string): StoredThreadRow | undefined => {
    const thread = threads.get(threadId)
    if (!thread || thread.archivedAt !== null) {
      return undefined
    }
    return thread
  }

  const sortByCreatedAt = <T extends { createdAt: string }>(items: T[]): T[] =>
    [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const sortToolCalls = (items: ToolCallRecord[]): ToolCallRecord[] =>
    [...items].sort((left, right) => left.startedAt.localeCompare(right.startedAt))

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
        messagesByThread: groupMessagesByThread(activeMessages),
        toolCallsByThread: groupToolCallsByThread(
          sortToolCalls(
            [...toolCalls.values()]
              .filter((toolCall) => threadIds.has(toolCall.threadId))
              .map(toToolCallRecord)
          )
        )
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

    startRun({
      runId,
      thread,
      updatedThread,
      requestMessageId,
      userMessage,
      createdAt
    }: StartRunInput) {
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
        assistantMessageId: null,
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
        run.assistantMessageId = assistantMessage.id
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
      return sortByCreatedAt(messages).filter((message) => message.threadId === threadId)
    },

    listThreadToolCalls(threadId) {
      return sortToolCalls([...toolCalls.values()].map(toToolCallRecord)).filter(
        (toolCall) => toolCall.threadId === threadId
      )
    },

    createToolCall(toolCall) {
      toolCalls.set(toolCall.id, {
        cwd: toolCall.cwd ?? null,
        error: toolCall.error ?? null,
        finishedAt: toolCall.finishedAt ?? null,
        id: toolCall.id,
        inputSummary: toolCall.inputSummary,
        outputSummary: toolCall.outputSummary ?? null,
        runId: toolCall.runId,
        startedAt: toolCall.startedAt,
        status: toolCall.status,
        threadId: toolCall.threadId,
        toolName: toolCall.toolName
      })
    },

    updateToolCall(toolCall) {
      if (!toolCalls.has(toolCall.id)) {
        return
      }

      toolCalls.set(toolCall.id, {
        cwd: toolCall.cwd ?? null,
        error: toolCall.error ?? null,
        finishedAt: toolCall.finishedAt ?? null,
        id: toolCall.id,
        inputSummary: toolCall.inputSummary,
        outputSummary: toolCall.outputSummary ?? null,
        runId: toolCall.runId,
        startedAt: toolCall.startedAt,
        status: toolCall.status,
        threadId: toolCall.threadId,
        toolName: toolCall.toolName
      })
    },

    deleteMessages({ thread, messageIds }) {
      const deletedIds = new Set(messageIds)
      const nextMessages = messages.filter((message) => !deletedIds.has(message.id))
      messages.length = 0
      messages.push(...nextMessages)

      const deletedRunIds = new Set(
        [...runs.values()]
          .filter(
            (run) =>
              (run.requestMessageId && deletedIds.has(run.requestMessageId)) ||
              (run.assistantMessageId && deletedIds.has(run.assistantMessageId))
          )
          .map((run) => run.id)
      )

      for (const runId of deletedRunIds) {
        runs.delete(runId)
      }

      for (const toolCall of [...toolCalls.values()]) {
        if (deletedRunIds.has(toolCall.runId)) {
          toolCalls.delete(toolCall.id)
        }
      }

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
