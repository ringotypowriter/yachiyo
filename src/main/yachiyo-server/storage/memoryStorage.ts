import type {
  MessageRecord,
  ThreadSearchResult,
  ToolCallRecord
} from '../../../shared/yachiyo/protocol'
import {
  groupLatestRunsByThread,
  groupToolCallsByThread,
  groupMessagesByThread,
  serializeThreadMemoryRecallState,
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
  const toToolCallRecordWithRun = (row: StoredToolCallRow): ToolCallRecord => toToolCallRecord(row)
  const applyThreadSnapshot = (
    storedThread: StoredThreadRow,
    nextThread: ReturnType<typeof toThreadRecord>
  ): void => {
    storedThread.branchFromThreadId = nextThread.branchFromThreadId ?? null
    storedThread.branchFromMessageId = nextThread.branchFromMessageId ?? null
    storedThread.headMessageId = nextThread.headMessageId ?? null
    storedThread.icon = nextThread.icon ?? null
    storedThread.memoryRecallState = serializeThreadMemoryRecallState(nextThread.memoryRecall)
    storedThread.preview = nextThread.preview ?? null
    storedThread.privacyMode = nextThread.privacyMode ? '1' : null
    storedThread.queuedFollowUpEnabledTools = nextThread.queuedFollowUpEnabledTools
      ? JSON.stringify(nextThread.queuedFollowUpEnabledTools)
      : null
    storedThread.queuedFollowUpEnabledSkillNames = nextThread.queuedFollowUpEnabledSkillNames
      ? JSON.stringify(nextThread.queuedFollowUpEnabledSkillNames)
      : null
    storedThread.queuedFollowUpMessageId = nextThread.queuedFollowUpMessageId ?? null
    storedThread.starredAt = nextThread.starredAt ?? null
    storedThread.title = nextThread.title
    storedThread.updatedAt = nextThread.updatedAt
    storedThread.workspacePath = nextThread.workspacePath ?? null
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

    getThreadCreatedAt(threadId) {
      return readThread(threadId)?.createdAt
    },

    createThread({ thread, createdAt, messages: initialMessages = [] }) {
      threads.set(thread.id, {
        id: thread.id,
        icon: thread.icon ?? null,
        title: thread.title,
        memoryRecallState: serializeThreadMemoryRecallState(thread.memoryRecall),
        workspacePath: thread.workspacePath ?? null,
        preview: thread.preview ?? null,
        branchFromThreadId: thread.branchFromThreadId ?? null,
        branchFromMessageId: thread.branchFromMessageId ?? null,
        queuedFollowUpEnabledTools: thread.queuedFollowUpEnabledTools
          ? JSON.stringify(thread.queuedFollowUpEnabledTools)
          : null,
        queuedFollowUpEnabledSkillNames: thread.queuedFollowUpEnabledSkillNames
          ? JSON.stringify(thread.queuedFollowUpEnabledSkillNames)
          : null,
        queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
        archivedAt: null,
        starredAt: null,
        privacyMode: thread.privacyMode ? '1' : null,
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

    setThreadIcon({ threadId, icon, updatedAt }) {
      const thread = threads.get(threadId)
      if (!thread) {
        return
      }

      thread.icon = icon
      thread.updatedAt = updatedAt
    },

    starThread({ threadId, starredAt }) {
      const thread = threads.get(threadId)
      if (!thread) return
      thread.starredAt = starredAt
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

    setThreadPrivacyMode({ threadId, privacyMode, updatedAt }) {
      const storedThread = threads.get(threadId)
      if (!storedThread || storedThread.archivedAt !== null) {
        return
      }

      storedThread.privacyMode = privacyMode ? '1' : null
      storedThread.updatedAt = updatedAt
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
        requestMessageId: requestMessageId ?? null,
        assistantMessageId: null,
        threadId: thread.id,
        status: 'running',
        error: null,
        createdAt,
        completedAt: null,
        promptTokens: null,
        completionTokens: null,
        totalPromptTokens: null,
        totalCompletionTokens: null
      })
    },

    completeRun({
      runId,
      updatedThread,
      assistantMessage,
      promptTokens,
      completionTokens,
      totalPromptTokens,
      totalCompletionTokens
    }: CompleteRunInput) {
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
        if (promptTokens !== undefined) run.promptTokens = promptTokens
        if (completionTokens !== undefined) run.completionTokens = completionTokens
        if (totalPromptTokens !== undefined) run.totalPromptTokens = totalPromptTokens
        if (totalCompletionTokens !== undefined) run.totalCompletionTokens = totalCompletionTokens
      }

      for (const [toolCallId, toolCall] of toolCalls.entries()) {
        if (toolCall.runId !== runId) {
          continue
        }

        toolCalls.set(toolCallId, {
          ...toolCall,
          assistantMessageId: assistantMessage.id
        })
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
        assistantMessageId: toolCall.assistantMessageId ?? null,
        cwd: toolCall.cwd ?? null,
        details: serializeToolCallDetails(toolCall.details),
        error: toolCall.error ?? null,
        finishedAt: toolCall.finishedAt ?? null,
        id: toolCall.id,
        inputSummary: toolCall.inputSummary,
        outputSummary: toolCall.outputSummary ?? null,
        requestMessageId: toolCall.requestMessageId ?? null,
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
        assistantMessageId: toolCall.assistantMessageId ?? null,
        cwd: toolCall.cwd ?? null,
        details: serializeToolCallDetails(toolCall.details),
        error: toolCall.error ?? null,
        finishedAt: toolCall.finishedAt ?? null,
        id: toolCall.id,
        inputSummary: toolCall.inputSummary,
        outputSummary: toolCall.outputSummary ?? null,
        requestMessageId: toolCall.requestMessageId ?? null,
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
        storedThread.queuedFollowUpEnabledSkillNames = null
        storedThread.queuedFollowUpMessageId = null
      }

      applyThreadSnapshot(storedThread, thread)
    },

    searchThreadsAndMessages({ query }) {
      const trimmed = query.trim()
      if (trimmed.length === 0) {
        return []
      }
      const lower = trimmed.toLowerCase()

      const activeThreads = [...threads.values()].filter((t) => t.archivedAt === null)

      const titleMatchedIds = new Set(
        activeThreads
          .filter(
            (t) =>
              t.title.toLowerCase().includes(lower) ||
              (t.preview ?? '').toLowerCase().includes(lower)
          )
          .map((t) => t.id)
      )

      const messageMatchesByThread = new Map<string, { messageId: string; content: string }[]>()
      for (const message of messages) {
        const thread = threads.get(message.threadId)
        if (!thread || thread.archivedAt !== null) continue
        if (!message.content.toLowerCase().includes(lower)) continue
        const existing = messageMatchesByThread.get(message.threadId) ?? []
        existing.push({ messageId: message.id, content: message.content })
        messageMatchesByThread.set(message.threadId, existing)
      }

      const allMatchedIds = new Set([...titleMatchedIds, ...messageMatchesByThread.keys()])
      if (allMatchedIds.size === 0) return []

      const matchedThreads = activeThreads
        .filter((t) => allMatchedIds.has(t.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 30)

      const results: ThreadSearchResult[] = matchedThreads.map((thread) => {
        const matches = messageMatchesByThread.get(thread.id) ?? []
        return {
          threadId: thread.id,
          threadTitle: thread.title,
          threadUpdatedAt: thread.updatedAt,
          titleMatched: titleMatchedIds.has(thread.id),
          messageMatches: matches.map((m) => {
            const idx = m.content.toLowerCase().indexOf(lower)
            const start = Math.max(0, idx - 8)
            const end = Math.min(m.content.length, start + 120)
            const snippet = `${start > 0 ? '…' : ''}${m.content.slice(start, end)}${end < m.content.length ? '…' : ''}`
            return { messageId: m.messageId, snippet }
          })
        }
      })

      return results
    }
  }
}
