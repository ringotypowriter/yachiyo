import type {
  ChannelGroupRecord,
  ChannelUserRecord,
  FolderRecord,
  GroupMessageEntry,
  MessageRecord,
  ScheduleRecord,
  ScheduleRunRecord,
  ThreadSearchResult,
  ToolCallRecord,
  UsageStatsInput,
  UsageStatsBucket,
  UsageStatsByModel,
  UsageStatsByWorkspace,
  UsageStatsResponse
} from '../../../shared/yachiyo/protocol'
import {
  groupLatestRunsByThread,
  groupToolCallsByThread,
  groupMessagesByThread,
  serializeModelOverride,
  serializeRuntimeBinding,
  serializeLastDelegatedSession,
  serializeThreadMemoryRecallState,
  serializeToolCallDetails,
  toRunRecoveryCheckpoint,
  toStoredRunRecoveryCheckpointRow,
  toRunRecord,
  toToolCallRecord,
  toThreadRecord,
  type CompleteRunInput,
  type RunRecoveryCheckpoint,
  type StartRunInput,
  type StoredRunRecoveryCheckpointRow,
  type StoredRunRow,
  type StoredToolCallRow,
  type StoredThreadRow,
  type YachiyoStorage
} from './storage.ts'
import { sortToolCallsChronologically } from '../../../shared/yachiyo/toolCallOrder.ts'

export function createInMemoryYachiyoStorage(): YachiyoStorage {
  const channelGroups = new Map<string, ChannelGroupRecord>()
  const channelUsers = new Map<string, ChannelUserRecord>()
  const threads = new Map<string, StoredThreadRow>()
  const folders = new Map<string, FolderRecord>()
  const schedules = new Map<string, ScheduleRecord>()
  const scheduleRuns = new Map<string, ScheduleRunRecord>()
  const messages: MessageRecord[] = []
  const runs = new Map<string, StoredRunRow>()
  const runRecoveryCheckpoints = new Map<string, StoredRunRecoveryCheckpointRow>()
  const toolCalls = new Map<string, StoredToolCallRow>()
  const imageAltTexts = new Map<string, { imageHash: string; altText: string }>()
  const groupMonitorBuffers = new Map<
    string,
    { phase: string; buffer: GroupMessageEntry[]; savedAt: string }
  >()

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
    sortToolCallsChronologically(items)
  const toToolCallRecordWithRun = (row: StoredToolCallRow): ToolCallRecord => toToolCallRecord(row)
  const applyThreadSnapshot = (
    storedThread: StoredThreadRow,
    nextThread: ReturnType<typeof toThreadRecord>
  ): void => {
    storedThread.branchFromThreadId = nextThread.branchFromThreadId ?? null
    storedThread.branchFromMessageId = nextThread.branchFromMessageId ?? null
    storedThread.handoffFromThreadId = nextThread.handoffFromThreadId ?? null
    storedThread.folderId = nextThread.folderId ?? null
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
    storedThread.modelOverride = serializeModelOverride(nextThread.modelOverride)
    storedThread.rollingSummary = nextThread.rollingSummary ?? null
    storedThread.summaryWatermarkMessageId = nextThread.summaryWatermarkMessageId ?? null
    storedThread.runtimeBinding = serializeRuntimeBinding(nextThread.runtimeBinding)
    storedThread.lastDelegatedSession = serializeLastDelegatedSession(
      nextThread.lastDelegatedSession
    )
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
        folders: [...folders.values()],
        latestRunsByThread,
        threads: activeThreads.map(toThreadRecord),
        messagesByThread: groupMessagesByThread(allMessages),
        toolCallsByThread: groupToolCallsByThread(allToolCalls)
      }
    },

    recoverInterruptedRuns({ error, finishedAt }) {
      const recoverableRunIds = new Set(runRecoveryCheckpoints.keys())
      const interruptedRunIds = [...runs.values()]
        .filter((run) => run.status === 'running')
        .map((run) => run.id)

      if (interruptedRunIds.length === 0) {
        return
      }

      for (const runId of interruptedRunIds) {
        if (recoverableRunIds.has(runId)) {
          continue
        }

        const run = runs.get(runId)
        if (!run) {
          continue
        }

        run.status = 'failed'
        run.error = error
        run.completedAt = finishedAt
      }

      for (const toolCall of toolCalls.values()) {
        if (
          toolCall.status !== 'running' ||
          !toolCall.runId ||
          !interruptedRunIds.includes(toolCall.runId)
        ) {
          continue
        }

        toolCall.status = 'failed'
        toolCall.error =
          toolCall.runId && recoverableRunIds.has(toolCall.runId)
            ? 'Tool execution was interrupted before completion.'
            : error
        toolCall.outputSummary = toolCall.error
        toolCall.finishedAt = finishedAt
      }
    },

    listRunRecoveryCheckpoints() {
      return [...runRecoveryCheckpoints.values()]
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .map(toRunRecoveryCheckpoint)
    },

    getRunRecoveryCheckpoint(runId) {
      const checkpoint = runRecoveryCheckpoints.get(runId)
      return checkpoint ? toRunRecoveryCheckpoint(checkpoint) : undefined
    },

    upsertRunRecoveryCheckpoint(checkpoint) {
      runRecoveryCheckpoints.set(
        checkpoint.runId,
        toStoredRunRecoveryCheckpointRow(checkpoint as RunRecoveryCheckpoint)
      )
    },

    deleteRunRecoveryCheckpoint(runId) {
      runRecoveryCheckpoints.delete(runId)
    },

    getRun(runId) {
      const run = runs.get(runId)
      return run ? toRunRecord(run) : undefined
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
        modelOverride: serializeModelOverride(thread.modelOverride),
        workspacePath: thread.workspacePath ?? null,
        preview: thread.preview ?? null,
        branchFromThreadId: thread.branchFromThreadId ?? null,
        branchFromMessageId: thread.branchFromMessageId ?? null,
        handoffFromThreadId: thread.handoffFromThreadId ?? null,
        folderId: thread.folderId ?? null,
        queuedFollowUpEnabledTools: thread.queuedFollowUpEnabledTools
          ? JSON.stringify(thread.queuedFollowUpEnabledTools)
          : null,
        queuedFollowUpEnabledSkillNames: thread.queuedFollowUpEnabledSkillNames
          ? JSON.stringify(thread.queuedFollowUpEnabledSkillNames)
          : null,
        queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
        archivedAt: null,
        savingStartedAt: null,
        starredAt: null,
        privacyMode: thread.privacyMode ? '1' : null,
        headMessageId: thread.headMessageId ?? null,
        source: thread.source ?? null,
        channelUserId: thread.channelUserId ?? null,
        channelGroupId: thread.channelGroupId ?? null,
        rollingSummary: thread.rollingSummary ?? null,
        summaryWatermarkMessageId: thread.summaryWatermarkMessageId ?? null,
        readAt: thread.readAt ?? null,
        createdFromEssentialId: thread.createdFromEssentialId ?? null,
        runtimeBinding: serializeRuntimeBinding(thread.runtimeBinding),
        lastDelegatedSession: serializeLastDelegatedSession(thread.lastDelegatedSession),
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

    archiveThread({ threadId, archivedAt, updatedAt, readAt }) {
      const thread = readThread(threadId)
      if (!thread) {
        return
      }

      thread.archivedAt = archivedAt
      thread.updatedAt = updatedAt
      thread.readAt = readAt ?? null
    },

    markThreadAsRead({ threadId, readAt }) {
      const thread = readThread(threadId)
      if (thread) {
        thread.readAt = readAt
      }
    },

    markThreadReviewed() {
      // selfReviewedAt is a sqlite-only CLI concern — no-op for in-memory storage
    },

    restoreThread({ threadId, updatedAt }) {
      const thread = readArchivedThread(threadId)
      if (!thread) {
        return
      }

      thread.archivedAt = null
      thread.updatedAt = updatedAt
    },

    beginThreadSave({ threadId, savingStartedAt }) {
      const thread = readThread(threadId)
      if (!thread) return
      thread.savingStartedAt = savingStartedAt
    },

    clearThreadSave({ threadId }) {
      const thread = threads.get(threadId)
      if (!thread) return
      thread.savingStartedAt = null
    },

    recoverInterruptedSaves() {
      const recoveredThreadIds: string[] = []
      for (const thread of threads.values()) {
        if (thread.savingStartedAt !== null) {
          recoveredThreadIds.push(thread.id)
          thread.savingStartedAt = null
        }
      }
      return recoveredThreadIds
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
        runRecoveryCheckpoints.delete(runId)
      }

      for (const [toolCallId, toolCall] of toolCalls.entries()) {
        if (
          toolCall.threadId === threadId ||
          (toolCall.runId && deletedRunIds.has(toolCall.runId))
        ) {
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
        totalCompletionTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        modelId: null,
        providerName: null,
        snapshotFileCount: null,
        workspacePath: null
      })
    },

    completeRun({
      runId,
      updatedThread,
      assistantMessage,
      promptTokens,
      completionTokens,
      totalPromptTokens,
      totalCompletionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      modelId,
      providerName
    }: CompleteRunInput) {
      const thread = threads.get(updatedThread.id)
      const run = runs.get(runId)
      runRecoveryCheckpoints.delete(runId)

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
        if (cacheReadTokens !== undefined) run.cacheReadTokens = cacheReadTokens
        if (cacheWriteTokens !== undefined) run.cacheWriteTokens = cacheWriteTokens
        if (modelId !== undefined) run.modelId = modelId
        if (providerName !== undefined) run.providerName = providerName
      }

      for (const [toolCallId, toolCall] of toolCalls.entries()) {
        if (toolCall.runId !== runId) {
          continue
        }

        if (toolCall.assistantMessageId) {
          continue
        }

        toolCalls.set(toolCallId, {
          ...toolCall,
          assistantMessageId: assistantMessage.id
        })
      }
    },

    cancelRun({
      runId,
      completedAt,
      promptTokens,
      completionTokens,
      totalPromptTokens,
      totalCompletionTokens,
      cacheReadTokens,
      cacheWriteTokens
    }) {
      const run = runs.get(runId)
      if (!run) {
        return
      }
      runRecoveryCheckpoints.delete(runId)

      run.status = 'cancelled'
      run.completedAt = completedAt
      if (promptTokens !== undefined) run.promptTokens = promptTokens
      if (completionTokens !== undefined) run.completionTokens = completionTokens
      if (totalPromptTokens !== undefined) run.totalPromptTokens = totalPromptTokens
      if (totalCompletionTokens !== undefined) run.totalCompletionTokens = totalCompletionTokens
      if (cacheReadTokens !== undefined) run.cacheReadTokens = cacheReadTokens
      if (cacheWriteTokens !== undefined) run.cacheWriteTokens = cacheWriteTokens

      for (const toolCall of toolCalls.values()) {
        if (toolCall.runId === runId && toolCall.status === 'running') {
          toolCall.status = 'failed'
          toolCall.finishedAt = completedAt
        }
      }
    },

    failRun({
      runId,
      completedAt,
      error,
      promptTokens,
      completionTokens,
      totalPromptTokens,
      totalCompletionTokens,
      cacheReadTokens,
      cacheWriteTokens
    }) {
      const run = runs.get(runId)
      if (!run) {
        return
      }
      runRecoveryCheckpoints.delete(runId)

      run.status = 'failed'
      run.error = error
      run.completedAt = completedAt
      if (promptTokens !== undefined) run.promptTokens = promptTokens
      if (completionTokens !== undefined) run.completionTokens = completionTokens
      if (totalPromptTokens !== undefined) run.totalPromptTokens = totalPromptTokens
      if (totalCompletionTokens !== undefined) run.totalCompletionTokens = totalCompletionTokens
      if (cacheReadTokens !== undefined) run.cacheReadTokens = cacheReadTokens
      if (cacheWriteTokens !== undefined) run.cacheWriteTokens = cacheWriteTokens

      for (const toolCall of toolCalls.values()) {
        if (toolCall.runId === runId && toolCall.status === 'running') {
          toolCall.status = 'failed'
          toolCall.finishedAt = completedAt
        }
      }
    },

    updateRunSnapshot(runId, snapshot) {
      const run = runs.get(runId)
      if (run) {
        run.snapshotFileCount = snapshot.fileCount
        run.workspacePath = snapshot.workspacePath ?? null
      }
    },

    listThreadRuns(threadId) {
      return sortByCreatedAt([...runs.values()])
        .filter((r) => r.threadId === threadId)
        .map(toRunRecord)
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
        runId: toolCall.runId ?? null,
        startedAt: toolCall.startedAt,
        stepBudget: toolCall.stepBudget ?? null,
        stepIndex: toolCall.stepIndex ?? null,
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
        runId: toolCall.runId ?? null,
        startedAt: toolCall.startedAt,
        stepBudget: toolCall.stepBudget ?? null,
        stepIndex: toolCall.stepIndex ?? null,
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
        if (toolCall.assistantMessageId && deletedIds.has(toolCall.assistantMessageId)) {
          toolCalls.delete(toolCall.id)
          continue
        }

        if (toolCall.runId && deletedRunIds.has(toolCall.runId) && !toolCall.assistantMessageId) {
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
    },

    searchThreadsAndMessagesFts({ query, limit = 30, includePrivate = false }) {
      // In-memory fallback: reuse the LIKE-based search since FTS5 isn't available,
      // but filter out privacy-mode threads when includePrivate is false.
      const results = this.searchThreadsAndMessages({ query })
      const filtered = includePrivate
        ? results
        : results.filter((r) => {
            const thread = threads.get(r.threadId)
            return thread != null && !thread.privacyMode
          })
      return filtered.slice(0, limit)
    },

    findActiveChannelThread(channelUserId, maxAgeMs) {
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
      const match = [...threads.values()]
        .filter((t) => t.channelUserId === channelUserId && !t.archivedAt && t.updatedAt >= cutoff)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      return match ? toThreadRecord(match) : undefined
    },

    getThreadTotalTokens(threadId) {
      const completedRuns = [...runs.values()]
        .filter((r) => r.threadId === threadId && r.status === 'completed' && r.completedAt)
        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
      const latest = completedRuns[0]
      if (!latest) return 0
      // Last step's prompt tokens = actual context window size.
      return latest.promptTokens ?? 0
    },

    listExternalThreads() {
      return [...threads.values()]
        .filter((t) => t.source && t.source !== 'local' && !t.archivedAt)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(toThreadRecord)
    },

    listChannelUsers() {
      return [...channelUsers.values()]
    },

    findChannelUser(platform, externalUserId) {
      return [...channelUsers.values()].find(
        (u) => u.platform === platform && u.externalUserId === externalUserId
      )
    },

    createChannelUser(user) {
      const record: ChannelUserRecord = { ...user, usedKTokens: 0 }
      channelUsers.set(record.id, record)
      return record
    },

    getChannelUser(id) {
      return channelUsers.get(id) ? { ...channelUsers.get(id)! } : undefined
    },

    updateChannelUser({ id, status, role, label, usageLimitKTokens, usedKTokens }) {
      const existing = channelUsers.get(id)
      if (!existing) return undefined

      if (status !== undefined) existing.status = status
      if (role !== undefined) existing.role = role
      if (label !== undefined) existing.label = label
      if (usageLimitKTokens !== undefined) existing.usageLimitKTokens = usageLimitKTokens
      if (usedKTokens !== undefined) existing.usedKTokens = usedKTokens

      return { ...existing }
    },

    // Channel groups (group discussion mode)

    listChannelGroups() {
      return [...channelGroups.values()]
    },

    findChannelGroup(platform, externalGroupId) {
      return [...channelGroups.values()].find(
        (g) => g.platform === platform && g.externalGroupId === externalGroupId
      )
    },

    getChannelGroup(id) {
      return channelGroups.has(id) ? { ...channelGroups.get(id)! } : undefined
    },

    createChannelGroup(group) {
      const record: ChannelGroupRecord = { ...group, createdAt: new Date().toISOString() }
      channelGroups.set(record.id, record)
      return record
    },

    updateChannelGroup({ id, status, name, label }) {
      const existing = channelGroups.get(id)
      if (!existing) return undefined

      if (status !== undefined) existing.status = status
      if (name !== undefined) existing.name = name
      if (label !== undefined) existing.label = label

      return { ...existing }
    },

    findActiveGroupThread(channelGroupId, maxAgeMs) {
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
      const match = [...threads.values()]
        .filter(
          (t) => t.channelGroupId === channelGroupId && !t.archivedAt && t.updatedAt >= cutoff
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      return match ? toThreadRecord(match) : undefined
    },

    // Thread folders
    listFolders() {
      return [...folders.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    getFolder(folderId) {
      return folders.get(folderId)
    },

    createFolder(folder) {
      folders.set(folder.id, { ...folder })
    },

    renameFolder({ folderId, title, updatedAt }) {
      const folder = folders.get(folderId)
      if (folder) {
        folder.title = title
        folder.updatedAt = updatedAt
      }
    },

    setFolderColor({ folderId, colorTag, updatedAt }) {
      const folder = folders.get(folderId)
      if (folder) {
        folder.colorTag = colorTag
        folder.updatedAt = updatedAt
      }
    },

    deleteFolder(folderId) {
      for (const thread of threads.values()) {
        if (thread.folderId === folderId) {
          thread.folderId = null
        }
      }
      folders.delete(folderId)
    },

    setThreadFolder({ threadId, folderId, updatedAt }) {
      const thread = threads.get(threadId)
      if (thread) {
        thread.folderId = folderId
        thread.updatedAt = updatedAt
      }
    },

    getImageAltText(imageHash) {
      return imageAltTexts.get(imageHash)
    },

    saveImageAltText(imageHash, altText) {
      imageAltTexts.set(imageHash, { imageHash, altText })
    },

    // Schedules — stub implementations for in-memory storage (used in tests)
    listSchedules() {
      return [...schedules.values()].sort((left, right) => left.name.localeCompare(right.name))
    },
    getSchedule(id) {
      return schedules.get(id)
    },
    createSchedule(schedule) {
      schedules.set(schedule.id, { ...schedule })
    },
    updateSchedule(schedule) {
      schedules.set(schedule.id, { ...schedule })
    },
    deleteSchedule(id) {
      schedules.delete(id)

      for (const [runId, run] of scheduleRuns.entries()) {
        if (run.scheduleId === id) {
          scheduleRuns.delete(runId)
        }
      }
    },
    createScheduleRun(run) {
      scheduleRuns.set(run.id, { ...run })
    },
    completeScheduleRun(input) {
      const run = scheduleRuns.get(input.id)
      if (!run) {
        return
      }

      scheduleRuns.set(input.id, {
        ...run,
        status: input.status,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.resultStatus ? { resultStatus: input.resultStatus } : {}),
        ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
        ...(input.error ? { error: input.error } : {}),
        ...(input.promptTokens != null ? { promptTokens: input.promptTokens } : {}),
        ...(input.completionTokens != null ? { completionTokens: input.completionTokens } : {}),
        completedAt: input.completedAt
      })
    },
    listScheduleRuns(scheduleId, limit = 50) {
      return [...scheduleRuns.values()]
        .filter((run) => run.scheduleId === scheduleId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, limit)
    },
    listRecentScheduleRuns(limit = 50) {
      return [...scheduleRuns.values()]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, limit)
    },
    getScheduleRunByThreadId(threadId) {
      return [...scheduleRuns.values()]
        .filter((run) => run.threadId === threadId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
    },
    recoverInterruptedScheduleRuns({ completedAt, error }) {
      for (const [runId, run] of scheduleRuns.entries()) {
        if (run.status !== 'running') {
          continue
        }

        scheduleRuns.set(runId, {
          ...run,
          status: 'failed',
          error,
          completedAt
        })
      }
    },

    // Usage statistics
    getUsageStats(input: UsageStatsInput): UsageStatsResponse {
      const completedRuns = [...runs.values()].filter((r) => {
        if (r.status !== 'completed' || !r.completedAt) return false
        if (input.from && r.completedAt < input.from) return false
        if (input.to && r.completedAt > input.to) return false
        if (input.modelId && r.modelId !== input.modelId) return false
        if (input.providerName && r.providerName !== input.providerName) return false
        if (input.workspacePath) {
          const thread = threads.get(r.threadId)
          if (input.workspacePath === '__null__') {
            if (thread?.workspacePath != null) return false
          } else if (thread?.workspacePath !== input.workspacePath) {
            return false
          }
        }
        return true
      })

      const formatPeriod = (date: string): string => {
        const d = date.slice(0, 10) // YYYY-MM-DD
        switch (input.period) {
          case 'year':
            return d.slice(0, 4)
          case 'month':
            return d.slice(0, 7)
          case 'week': {
            const dt = new Date(d)
            const jan1 = new Date(dt.getFullYear(), 0, 1)
            const weekNum = Math.ceil(
              ((dt.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7
            )
            return `${dt.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
          }
          default:
            return d
        }
      }

      // Buckets
      const bucketMap = new Map<string, UsageStatsBucket>()
      for (const r of completedRuns) {
        const key = formatPeriod(r.completedAt!)
        const b = bucketMap.get(key) ?? {
          periodStart: key,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          cacheAwarePromptTokens: 0,
          runCount: 0
        }
        b.totalPromptTokens += r.totalPromptTokens ?? 0
        b.totalCompletionTokens += r.totalCompletionTokens ?? 0
        b.totalCacheReadTokens += r.cacheReadTokens ?? 0
        b.totalCacheWriteTokens += r.cacheWriteTokens ?? 0
        if (r.cacheReadTokens != null) b.cacheAwarePromptTokens += r.totalPromptTokens ?? 0
        b.runCount++
        bucketMap.set(key, b)
      }
      const buckets = [...bucketMap.values()].sort((a, b) =>
        a.periodStart.localeCompare(b.periodStart)
      )

      // By model
      const modelMap = new Map<string, UsageStatsByModel>()
      for (const r of completedRuns) {
        if (!r.modelId) continue
        const key = `${r.modelId}|${r.providerName ?? 'unknown'}`
        const m = modelMap.get(key) ?? {
          modelId: r.modelId,
          providerName: r.providerName ?? 'unknown',
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          cacheAwarePromptTokens: 0,
          runCount: 0
        }
        m.totalPromptTokens += r.totalPromptTokens ?? 0
        m.totalCompletionTokens += r.totalCompletionTokens ?? 0
        m.totalCacheReadTokens += r.cacheReadTokens ?? 0
        m.totalCacheWriteTokens += r.cacheWriteTokens ?? 0
        if (r.cacheReadTokens != null) m.cacheAwarePromptTokens += r.totalPromptTokens ?? 0
        m.runCount++
        modelMap.set(key, m)
      }
      const byModel = [...modelMap.values()].sort(
        (a, b) => b.totalPromptTokens - a.totalPromptTokens
      )

      // By workspace
      const wsMap = new Map<string, UsageStatsByWorkspace>()
      for (const r of completedRuns) {
        const thread = threads.get(r.threadId)
        const ws = thread?.workspacePath ?? '__null__'
        const w = wsMap.get(ws) ?? {
          workspacePath: ws,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          cacheAwarePromptTokens: 0,
          runCount: 0
        }
        w.totalPromptTokens += r.totalPromptTokens ?? 0
        w.totalCompletionTokens += r.totalCompletionTokens ?? 0
        w.totalCacheReadTokens += r.cacheReadTokens ?? 0
        w.totalCacheWriteTokens += r.cacheWriteTokens ?? 0
        if (r.cacheReadTokens != null) w.cacheAwarePromptTokens += r.totalPromptTokens ?? 0
        w.runCount++
        wsMap.set(ws, w)
      }
      const byWorkspace = [...wsMap.values()].sort(
        (a, b) => b.totalPromptTokens - a.totalPromptTokens
      )

      // Totals
      const totals = {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheAwarePromptTokens: 0,
        runCount: completedRuns.length
      }
      for (const r of completedRuns) {
        totals.promptTokens += r.totalPromptTokens ?? 0
        totals.completionTokens += r.totalCompletionTokens ?? 0
        totals.cacheReadTokens += r.cacheReadTokens ?? 0
        totals.cacheWriteTokens += r.cacheWriteTokens ?? 0
        if (r.cacheReadTokens != null) totals.cacheAwarePromptTokens += r.totalPromptTokens ?? 0
      }

      return { buckets, byModel, byWorkspace, totals }
    },

    // Group monitor buffer persistence
    saveGroupMonitorBuffer({ groupId, phase, buffer, savedAt }) {
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
      groupMonitorBuffers.set(groupId, { phase, buffer: stripped as GroupMessageEntry[], savedAt })
    },
    loadGroupMonitorBuffer(groupId) {
      return groupMonitorBuffers.get(groupId)
    },
    deleteGroupMonitorBuffer(groupId) {
      groupMonitorBuffers.delete(groupId)
    }
  }
}
