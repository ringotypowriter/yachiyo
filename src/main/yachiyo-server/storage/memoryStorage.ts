import type { MessageRecord, ToolCallRecord } from '../../../shared/yachiyo/protocol'
import {
  groupLatestRunsByThread,
  groupToolCallsByThread,
  groupMessagesByThread,
  serializeToolCallDetails,
  toRunRecord,
  toToolCallRecord,
  toThreadRecord,
  type CompleteRunInput,
  type StartRunInput,
  type StoredRunRow,
  type StoredToolCallRow,
  type StoredThreadRow,
  type YachiyoStorage
} from './storage.ts'

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
  const readArchivedThread = (threadId: string): StoredThreadRow | undefined => {
    const thread = threads.get(threadId)
    if (!thread || thread.archivedAt === null) {
      return undefined
    }
    return thread
  }

  const sortByCreatedAt = <T extends { createdAt: string }>(items: T[]): T[] =>
    [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const sortToolCalls = (items: ToolCallRecord[]): ToolCallRecord[] =>
    [...items].sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  const toToolCallRecordWithRun = (row: StoredToolCallRow): ToolCallRecord => {
    const run = runs.get(row.runId)

    return toToolCallRecord({
      ...row,
      assistantMessageId: run?.assistantMessageId ?? null,
      requestMessageId: run?.requestMessageId ?? null
    })
  }
  const applyThreadSnapshot = (
    storedThread: StoredThreadRow,
    nextThread: ReturnType<typeof toThreadRecord>
  ): void => {
    storedThread.branchFromThreadId = nextThread.branchFromThreadId ?? null
    storedThread.branchFromMessageId = nextThread.branchFromMessageId ?? null
    storedThread.headMessageId = nextThread.headMessageId ?? null
    storedThread.preview = nextThread.preview ?? null
    storedThread.queuedFollowUpEnabledTools = nextThread.queuedFollowUpEnabledTools
      ? JSON.stringify(nextThread.queuedFollowUpEnabledTools)
      : null
    storedThread.queuedFollowUpMessageId = nextThread.queuedFollowUpMessageId ?? null
    storedThread.title = nextThread.title
    storedThread.updatedAt = nextThread.updatedAt
  }

  return {
    close() {
      // In-memory storage does not hold external resources.
    },

    bootstrap() {
      const sortedThreads = [...threads.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
      )
      const activeThreads = sortedThreads.filter((thread) => thread.archivedAt === null)
      const archivedThreads = sortedThreads.filter((thread) => thread.archivedAt !== null)
      const threadIds = new Set(sortedThreads.map((thread) => thread.id))
      const allMessages = sortByCreatedAt(
        messages.filter((message) => threadIds.has(message.threadId))
      )
      const allToolCalls = sortToolCalls(
        [...toolCalls.values()]
          .filter((toolCall) => threadIds.has(toolCall.threadId))
          .map(toToolCallRecordWithRun)
      )
      const latestRunsByThread = groupLatestRunsByThread(
        [...runs.values()]
          .filter((run) => threadIds.has(run.threadId))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map(toRunRecord)
      )

      return {
        archivedThreads: archivedThreads.map(toThreadRecord),
        latestRunsByThread,
        threads: activeThreads.map(toThreadRecord),
        messagesByThread: groupMessagesByThread(allMessages),
        toolCallsByThread: groupToolCallsByThread(allToolCalls)
      }
    },

    recoverInterruptedRuns({ error, finishedAt }) {
      const interruptedRunIds = [...runs.values()]
        .filter((run) => run.status === 'running')
        .map((run) => run.id)

      if (interruptedRunIds.length === 0) {
        return
      }

      for (const runId of interruptedRunIds) {
        const run = runs.get(runId)
        if (!run) {
          continue
        }

        run.status = 'failed'
        run.error = error
        run.completedAt = finishedAt
      }

      for (const toolCall of toolCalls.values()) {
        if (toolCall.status !== 'running' || !interruptedRunIds.includes(toolCall.runId)) {
          continue
        }

        toolCall.status = 'failed'
        toolCall.error = error
        toolCall.outputSummary = error
        toolCall.finishedAt = finishedAt
      }
    },

    getThread(threadId) {
      const thread = readThread(threadId)
      return thread ? toThreadRecord(thread) : undefined
    },

    getArchivedThread(threadId) {
      const thread = readArchivedThread(threadId)
      return thread ? toThreadRecord(thread) : undefined
    },

    createThread({ thread, createdAt, messages: initialMessages = [] }) {
      threads.set(thread.id, {
        id: thread.id,
        title: thread.title,
        preview: thread.preview ?? null,
        branchFromThreadId: thread.branchFromThreadId ?? null,
        branchFromMessageId: thread.branchFromMessageId ?? null,
        queuedFollowUpEnabledTools: thread.queuedFollowUpEnabledTools
          ? JSON.stringify(thread.queuedFollowUpEnabledTools)
          : null,
        queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
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

    restoreThread({ threadId, updatedAt }) {
      const thread = readArchivedThread(threadId)
      if (!thread) {
        return
      }

      thread.archivedAt = null
      thread.updatedAt = updatedAt
    },

    deleteThread({ threadId }) {
      threads.delete(threadId)

      const nextMessages = messages.filter((message) => message.threadId !== threadId)
      messages.length = 0
      messages.push(...nextMessages)

      const deletedRunIds = new Set(
        [...runs.values()].filter((run) => run.threadId === threadId).map((run) => run.id)
      )
      for (const runId of deletedRunIds) {
        runs.delete(runId)
      }

      for (const [toolCallId, toolCall] of toolCalls.entries()) {
        if (toolCall.threadId === threadId || deletedRunIds.has(toolCall.runId)) {
          toolCalls.delete(toolCallId)
        }
      }
    },

    updateThread(nextThread) {
      const storedThread = threads.get(nextThread.id)
      if (!storedThread || storedThread.archivedAt !== null) {
        return
      }

      applyThreadSnapshot(storedThread, nextThread)
    },

    saveThreadMessage({ thread, updatedThread, message, replacedMessageId }) {
      const storedThread = threads.get(thread.id)
      if (!storedThread || storedThread.archivedAt !== null) {
        return
      }

      if (replacedMessageId) {
        const nextMessages = messages.filter((current) => current.id !== replacedMessageId)
        messages.length = 0
        messages.push(...nextMessages)
      }

      messages.push(message)
      applyThreadSnapshot(storedThread, updatedThread)
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
      storedThread.preview = updatedThread.preview ?? null
      storedThread.queuedFollowUpEnabledTools = updatedThread.queuedFollowUpEnabledTools
        ? JSON.stringify(updatedThread.queuedFollowUpEnabledTools)
        : null
      storedThread.queuedFollowUpMessageId = updatedThread.queuedFollowUpMessageId ?? null
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
        applyThreadSnapshot(thread, updatedThread)
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

    updateMessage(message) {
      const currentIndex = messages.findIndex((current) => current.id === message.id)
      if (currentIndex < 0) {
        return
      }

      messages[currentIndex] = message
    },

    listThreadToolCalls(threadId) {
      return sortToolCalls([...toolCalls.values()].map(toToolCallRecordWithRun)).filter(
        (toolCall) => toolCall.threadId === threadId
      )
    },

    createToolCall(toolCall) {
      toolCalls.set(toolCall.id, {
        cwd: toolCall.cwd ?? null,
        details: serializeToolCallDetails(toolCall.details),
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
        details: serializeToolCallDetails(toolCall.details),
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

      if (deletedIds.has(storedThread.queuedFollowUpMessageId ?? '')) {
        storedThread.queuedFollowUpEnabledTools = null
        storedThread.queuedFollowUpMessageId = null
      }

      applyThreadSnapshot(storedThread, thread)
    }
  }
}
