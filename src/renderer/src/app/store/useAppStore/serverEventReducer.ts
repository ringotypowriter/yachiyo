import type { AppState } from '../useAppStore.ts'
import type { Message, YachiyoServerEvent } from '../../types.ts'
import {
  DEFAULT_RUN_MODE_ID,
  normalizeUserEnabledTools
} from '../../../../../shared/yachiyo/protocol.ts'
import { isVisibleExternalThread } from '../../../features/threads/lib/threadVisibility.ts'
import {
  DEFAULT_SETTINGS,
  appendSubagentProgressEntry,
  appendTextBlockDelta,
  deriveActiveThreadRunState,
  deriveSubagentStateFromToolCalls,
  finalizePendingMessage,
  removeActiveSubagentId,
  removeComposerDraft,
  removeFolder,
  removePendingSteerMessage,
  removeReasoning,
  removeThread,
  removeThreadRetryInfo,
  resolveActiveRequestMessageId,
  saveCollapsedFolderIds,
  setReasoningEffortValue,
  setThreadRunPhaseValue,
  setThreadRunStatusValue,
  setThreadStringValue,
  sortThreads,
  stripLatestRunTokens,
  syncSubagentStateWithToolCall,
  terminateRunToolCalls,
  updateRunRecord,
  upsertActiveSubagentId,
  upsertFolder,
  upsertLatestRun,
  upsertMessage,
  upsertThread,
  upsertToolCall,
  withFilterBase
} from './helpers.ts'

export function reduceServerEvent(state: AppState, event: YachiyoServerEvent): Partial<AppState> {
  if (event.type === 'thread.archived') {
    const threads = removeThread(state.threads, event.threadId)
    const archivedThreads = upsertThread(state.archivedThreads, event.thread)
    const nextState = {
      ...state,
      activeThreadId:
        state.activeThreadId === event.threadId ? (threads[0]?.id ?? null) : state.activeThreadId,
      activeArchivedThreadId:
        state.activeArchivedThreadId === event.threadId
          ? event.threadId
          : (state.activeArchivedThreadId ?? event.threadId),
      archivedThreads,
      composerDrafts: removeComposerDraft(state.composerDrafts, event.threadId),
      threads
    }

    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'thread.restored') {
    const archivedThreads = removeThread(state.archivedThreads, event.threadId)
    const threads = upsertThread(state.threads, event.thread)
    const nextState = {
      ...state,
      activeArchivedThreadId:
        state.activeArchivedThreadId === event.threadId
          ? (archivedThreads[0]?.id ?? null)
          : state.activeArchivedThreadId,
      activeThreadId: event.thread.id,
      archivedThreads,
      justDoneRunIdsByThread: setThreadStringValue(
        state.justDoneRunIdsByThread,
        event.threadId,
        null
      ),
      ...withFilterBase(state.sidebarFilter, 'all'),
      threads
    }

    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'thread.deleted') {
    const activeRunIdsByThread = { ...state.activeRunIdsByThread }
    delete activeRunIdsByThread[event.threadId]
    const activeRequestMessageIdsByThread = { ...state.activeRequestMessageIdsByThread }
    delete activeRequestMessageIdsByThread[event.threadId]
    const threads = removeThread(state.threads, event.threadId)
    const archivedThreads = removeThread(state.archivedThreads, event.threadId)
    const externalThreads = removeThread(state.externalThreads, event.threadId)
    const messages = { ...state.messages }
    delete messages[event.threadId]
    const justDoneRunIdsByThread = { ...state.justDoneRunIdsByThread }
    delete justDoneRunIdsByThread[event.threadId]
    const latestRunsByThread = { ...state.latestRunsByThread }
    delete latestRunsByThread[event.threadId]
    const runsByThread = { ...state.runsByThread }
    delete runsByThread[event.threadId]
    const runPhasesByThread = { ...state.runPhasesByThread }
    delete runPhasesByThread[event.threadId]
    const receivingModelOutputByThread = { ...state.receivingModelOutputByThread }
    delete receivingModelOutputByThread[event.threadId]
    const runStatusesByThread = { ...state.runStatusesByThread }
    delete runStatusesByThread[event.threadId]
    const toolCalls = { ...state.toolCalls }
    delete toolCalls[event.threadId]
    const todoListsByThread = { ...state.todoListsByThread }
    delete todoListsByThread[event.threadId]
    const planDocumentsByThread = { ...state.planDocumentsByThread }
    delete planDocumentsByThread[event.threadId]
    const subagentActiveIdsByThread = { ...state.subagentActiveIdsByThread }
    delete subagentActiveIdsByThread[event.threadId]
    const subagentProgressTimelineByThread = { ...state.subagentProgressTimelineByThread }
    delete subagentProgressTimelineByThread[event.threadId]
    const subagentStateById = Object.fromEntries(
      Object.entries(state.subagentStateById).filter(
        ([, subagent]) => subagent.threadId !== event.threadId
      )
    )

    const deletingActiveThread = state.activeThreadId === event.threadId
    const activeThreadId = deletingActiveThread ? (threads[0]?.id ?? null) : state.activeThreadId
    const nextState = {
      ...state,
      ...(deletingActiveThread
        ? {
            activeEssentialId: null,
            pendingModelOverride: null,
            pendingAcpBinding: null,
            pendingWorkspacePath: null
          }
        : {}),
      activeArchivedThreadId:
        state.activeArchivedThreadId === event.threadId
          ? (archivedThreads[0]?.id ?? null)
          : state.activeArchivedThreadId,
      activeRequestMessageIdsByThread,
      activeRunIdsByThread,
      activeThreadId,
      archivedThreads,
      composerDrafts: removeComposerDraft(state.composerDrafts, event.threadId),
      justDoneRunIdsByThread,
      latestRunsByThread,
      runsByThread,
      messages,
      pendingSteerMessages: removePendingSteerMessage(state.pendingSteerMessages, event.threadId),
      receivingModelOutputByThread,
      runPhasesByThread,
      runStatusesByThread,
      subagentActiveIdsByThread,
      subagentProgressTimelineByThread,
      subagentStateById,
      externalThreads,
      todoListsByThread,
      planDocumentsByThread,
      toolCalls,
      threads
    }

    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'thread.created' || event.type === 'thread.updated') {
    const nextActiveRequestMessageId = state.activeRunIdsByThread[event.threadId]
      ? resolveActiveRequestMessageId(
          event.thread,
          state.messages[event.threadId] ?? [],
          state.activeRequestMessageIdsByThread[event.threadId] ?? null
        )
      : (state.activeRequestMessageIdsByThread[event.threadId] ?? null)
    const shouldClearPendingSteer =
      Boolean(state.pendingSteerMessages[event.threadId]) &&
      Boolean(state.activeRunIdsByThread[event.threadId]) &&
      Boolean(event.thread.headMessageId) &&
      event.thread.headMessageId !== (state.activeRequestMessageIdsByThread[event.threadId] ?? null)

    const nextState = {
      ...state,
      activeRequestMessageIdsByThread: setThreadStringValue(
        state.activeRequestMessageIdsByThread,
        event.threadId,
        nextActiveRequestMessageId
      ),
      archivedThreads: removeThread(state.archivedThreads, event.threadId),
      externalThreads: isVisibleExternalThread(event.thread)
        ? sortThreads([
            event.thread,
            ...state.externalThreads.filter((item) => item.id !== event.thread.id)
          ])
        : removeThread(state.externalThreads, event.threadId),
      pendingSteerMessages: shouldClearPendingSteer
        ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
        : state.pendingSteerMessages,
      reasoningEffortByThread: setReasoningEffortValue(
        state.reasoningEffortByThread,
        event.threadId,
        event.thread.reasoningEffort
      ),
      threads: upsertThread(state.threads, event.thread)
    }

    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'thread.state.replaced') {
    const activeRunId = state.activeRunIdsByThread[event.threadId]
    const nextActiveRequestMessageId = activeRunId
      ? resolveActiveRequestMessageId(
          event.thread,
          event.messages,
          state.activeRequestMessageIdsByThread[event.threadId] ?? null
        )
      : (state.activeRequestMessageIdsByThread[event.threadId] ?? null)

    // While a run is active, the server snapshot won't contain the
    // in-flight assistant message (not persisted until completion).
    // Server messages are still authoritative for persisted state
    // (steers, deletions), so use them — but re-inject the single
    // pending assistant message that only exists client-side.
    let nextMessages = event.messages
    if (activeRunId) {
      const pending = state.pendingAssistantMessages[activeRunId]
      if (pending) {
        const live = (state.messages[event.threadId] ?? []).find((m) => m.id === pending.messageId)
        if (live && !nextMessages.some((m) => m.id === pending.messageId)) {
          nextMessages = upsertMessage(nextMessages, live)
        }
      }
    }

    const currentMessages = state.messages[event.threadId] ?? []
    const hadMessageDecrease =
      event.messages.length < currentMessages.length ||
      currentMessages.some((m) => !event.messages.some((em) => em.id === m.id))

    // When a pending steer resolves (tool just finished), the run is
    // about to restart. Reset to 'preparing' so the conversation group
    // shows a PreparingBubble instead of empty space while waiting for
    // the first message.delta from the restarted run.
    const hadPendingSteer = Boolean(state.pendingSteerMessages[event.threadId])
    const toolCalls = {
      ...state.toolCalls,
      [event.threadId]: event.toolCalls
    }

    const nextState = {
      ...state,
      activeRequestMessageIdsByThread: setThreadStringValue(
        state.activeRequestMessageIdsByThread,
        event.threadId,
        nextActiveRequestMessageId
      ),
      archivedThreads: removeThread(state.archivedThreads, event.threadId),
      messages: {
        ...state.messages,
        [event.threadId]: nextMessages
      },
      pendingSteerMessages: removePendingSteerMessage(state.pendingSteerMessages, event.threadId),
      runPhasesByThread: hadPendingSteer
        ? setThreadRunPhaseValue(state.runPhasesByThread, event.threadId, 'preparing')
        : state.runPhasesByThread,
      toolCalls,
      latestRunsByThread: hadMessageDecrease
        ? stripLatestRunTokens(state.latestRunsByThread, event.threadId)
        : state.latestRunsByThread,
      ...deriveSubagentStateFromToolCalls(
        toolCalls,
        state.subagentStateById,
        state.subagentProgressTimelineByThread
      ),
      threads: upsertThread(state.threads, event.thread)
    }

    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'settings.updated') {
    return {
      config: event.config ?? state.config,
      enabledTools: normalizeUserEnabledTools(event.config?.enabledTools, state.enabledTools),
      runMode: event.config?.runMode ?? state.runMode ?? DEFAULT_RUN_MODE_ID,
      lastError: null,
      settings: event.settings ?? state.settings ?? DEFAULT_SETTINGS
    }
  }

  if (event.type === 'run.created') {
    const prevRun = state.latestRunsByThread[event.threadId]
    const nextState = {
      ...state,
      activeRequestMessageIdsByThread: event.requestMessageId
        ? {
            ...state.activeRequestMessageIdsByThread,
            [event.threadId]: event.requestMessageId
          }
        : state.activeRequestMessageIdsByThread,
      activeRunIdsByThread: {
        ...state.activeRunIdsByThread,
        [event.threadId]: event.runId
      },
      lastError: null,
      justDoneRunIdsByThread: setThreadStringValue(
        state.justDoneRunIdsByThread,
        event.threadId,
        null
      ),
      latestRunsByThread: upsertLatestRun(state.latestRunsByThread, {
        id: event.runId,
        threadId: event.threadId,
        status: 'running',
        createdAt: event.timestamp,
        ...(event.requestMessageId ? { requestMessageId: event.requestMessageId } : {}),
        ...(event.runMode ? { runMode: event.runMode } : {}),
        ...(prevRun?.promptTokens != null ? { promptTokens: prevRun.promptTokens } : {}),
        ...(prevRun?.completionTokens != null ? { completionTokens: prevRun.completionTokens } : {})
      }),
      runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
        ...run,
        id: event.runId,
        threadId: event.threadId,
        status: 'running',
        createdAt: run?.createdAt ?? event.timestamp,
        ...(event.requestMessageId ? { requestMessageId: event.requestMessageId } : {}),
        ...(event.runMode ? { runMode: event.runMode } : {}),
        recalledMemoryEntries: run?.recalledMemoryEntries,
        recallDecision: run?.recallDecision
      })),
      runPhasesByThread: setThreadRunPhaseValue(
        state.runPhasesByThread,
        event.threadId,
        'preparing'
      ),
      runStatusesByThread: setThreadRunStatusValue(
        state.runStatusesByThread,
        event.threadId,
        'running'
      )
    }

    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'run.memory.recalled') {
    return {
      latestRunsByThread:
        state.latestRunsByThread[event.threadId]?.id === event.runId
          ? upsertLatestRun(state.latestRunsByThread, {
              ...state.latestRunsByThread[event.threadId]!,
              recalledMemoryEntries: event.recalledMemoryEntries,
              recallDecision: event.recallDecision
            })
          : state.latestRunsByThread,
      runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
        ...run,
        id: event.runId,
        threadId: event.threadId,
        status: run?.status ?? 'running',
        createdAt: run?.createdAt ?? event.timestamp,
        ...(event.requestMessageId ? { requestMessageId: event.requestMessageId } : {}),
        recalledMemoryEntries: event.recalledMemoryEntries,
        recallDecision: event.recallDecision,
        ...(run?.completedAt ? { completedAt: run.completedAt } : {}),
        ...(run?.error ? { error: run.error } : {})
      }))
    }
  }

  if (event.type === 'run.context.compiled') {
    return {
      latestRunsByThread:
        state.latestRunsByThread[event.threadId]?.id === event.runId
          ? upsertLatestRun(state.latestRunsByThread, {
              ...state.latestRunsByThread[event.threadId]!,
              contextSources: event.contextSources
            })
          : state.latestRunsByThread,
      runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
        ...run,
        id: event.runId,
        threadId: event.threadId,
        status: run?.status ?? 'running',
        createdAt: run?.createdAt ?? event.timestamp,
        contextSources: event.contextSources,
        ...(run?.completedAt ? { completedAt: run.completedAt } : {}),
        ...(run?.error ? { error: run.error } : {})
      }))
    }
  }

  if (event.type === 'message.started') {
    const nextMessage: Message = {
      id: event.messageId,
      threadId: event.threadId,
      parentMessageId: event.parentMessageId,
      role: 'assistant',
      content: '',
      textBlocks: [],
      status: 'streaming',
      createdAt: event.timestamp
    }
    const nextThreadMessages = upsertMessage(state.messages[event.threadId] ?? [], nextMessage)
    const retryInfoByThread =
      state.activeRunIdsByThread[event.threadId] === event.runId
        ? removeThreadRetryInfo(state.retryInfoByThread, event.threadId)
        : state.retryInfoByThread

    return {
      messages: {
        ...state.messages,
        [event.threadId]: nextThreadMessages
      },
      pendingAssistantMessages: {
        ...state.pendingAssistantMessages,
        [event.runId]: {
          messageId: event.messageId,
          parentMessageId: event.parentMessageId,
          threadId: event.threadId,
          shouldStartNewTextBlock: true
        }
      },
      retryInfoByThread
    }
  }

  if (event.type === 'message.reasoning.delta') {
    const pending = state.pendingAssistantMessages[event.runId]
    if (!pending) return {}

    const nextThreadMessages = (state.messages[event.threadId] ?? []).map((message) =>
      message.id === pending.messageId
        ? { ...message, reasoning: (message.reasoning ?? '') + event.delta }
        : message
    )
    const retryInfoByThread =
      state.activeRunIdsByThread[event.threadId] === event.runId
        ? removeThreadRetryInfo(state.retryInfoByThread, event.threadId)
        : state.retryInfoByThread

    return {
      messages: { ...state.messages, [event.threadId]: nextThreadMessages },
      retryInfoByThread,
      receivingModelOutputByThread: {
        ...state.receivingModelOutputByThread,
        [event.threadId]: true
      }
    }
  }

  if (event.type === 'message.delta') {
    const pending = state.pendingAssistantMessages[event.runId]
    if (!pending) return {}

    let nextPendingAssistantMessage = pending

    const nextThreadMessages = (state.messages[event.threadId] ?? []).map((message) =>
      message.id === pending.messageId
        ? (() => {
            const nextTextBlockState = appendTextBlockDelta({
              textBlocks: message.textBlocks,
              delta: event.delta,
              timestamp: event.timestamp,
              shouldStartNewTextBlock: pending.shouldStartNewTextBlock
            })
            nextPendingAssistantMessage = {
              ...pending,
              shouldStartNewTextBlock: nextTextBlockState.shouldStartNewTextBlock
            }

            return {
              ...message,
              content: message.content + event.delta,
              textBlocks: nextTextBlockState.textBlocks
            }
          })()
        : message
    )
    const retryInfoByThread =
      state.activeRunIdsByThread[event.threadId] === event.runId
        ? removeThreadRetryInfo(state.retryInfoByThread, event.threadId)
        : state.retryInfoByThread

    const nextState = {
      ...state,
      messages: {
        ...state.messages,
        [event.threadId]: nextThreadMessages
      },
      pendingAssistantMessages: {
        ...state.pendingAssistantMessages,
        [event.runId]: nextPendingAssistantMessage
      },
      retryInfoByThread,
      receivingModelOutputByThread: {
        ...state.receivingModelOutputByThread,
        [event.threadId]: true
      },
      runPhasesByThread: setThreadRunPhaseValue(
        state.runPhasesByThread,
        event.threadId,
        'streaming'
      )
    }

    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'message.completed') {
    const pendingAssistantMessages =
      event.message.role === 'assistant'
        ? (() => {
            const next = { ...state.pendingAssistantMessages }
            delete next[event.runId]
            return next
          })()
        : state.pendingAssistantMessages

    return {
      messages: {
        ...state.messages,
        [event.threadId]: upsertMessage(state.messages[event.threadId] ?? [], event.message)
      },
      pendingAssistantMessages
    }
  }

  if (event.type === 'tool.updated') {
    const eventRunId = event.runId
    const pending = eventRunId ? state.pendingAssistantMessages[eventRunId] : undefined
    const isCurrentActiveRun =
      eventRunId !== undefined && state.activeRunIdsByThread[event.threadId] === eventRunId
    const currentPhase = state.runPhasesByThread[event.threadId]
    const nextToolCalls = {
      ...state.toolCalls,
      [event.threadId]: upsertToolCall(state.toolCalls[event.threadId] ?? [], event.toolCall)
    }
    const nextSubagentState = syncSubagentStateWithToolCall({
      threadId: event.threadId,
      toolCall: event.toolCall,
      subagentActiveIdsByThread: state.subagentActiveIdsByThread,
      subagentStateById: state.subagentStateById
    })
    const nextState = {
      ...state,
      pendingAssistantMessages: pending
        ? {
            ...state.pendingAssistantMessages,
            [eventRunId!]: {
              ...pending,
              shouldStartNewTextBlock: true
            }
          }
        : state.pendingAssistantMessages,
      toolCalls: nextToolCalls,
      ...nextSubagentState,
      retryInfoByThread: isCurrentActiveRun
        ? removeThreadRetryInfo(state.retryInfoByThread, event.threadId)
        : state.retryInfoByThread,
      receivingModelOutputByThread:
        event.toolCall.status === 'completed' || event.toolCall.status === 'failed'
          ? { ...state.receivingModelOutputByThread, [event.threadId]: false }
          : state.receivingModelOutputByThread,
      runPhasesByThread:
        currentPhase === 'preparing' && event.toolCall.status !== 'preparing'
          ? setThreadRunPhaseValue(state.runPhasesByThread, event.threadId, 'streaming')
          : state.runPhasesByThread
    }
    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'todo.updated') {
    const todoListsByThread = { ...state.todoListsByThread }
    if (event.items.length === 0) {
      delete todoListsByThread[event.threadId]
    } else {
      todoListsByThread[event.threadId] = {
        items: event.items.map((item) => ({ ...item })),
        updatedAt: event.timestamp
      }
    }

    return { todoListsByThread }
  }

  if (event.type === 'run.usage.updated') {
    if (state.activeRunIdsByThread[event.threadId] !== event.runId) return {}
    const existing = state.latestRunsByThread[event.threadId]
    if (!existing || existing.id !== event.runId) return {}
    return {
      latestRunsByThread: {
        ...state.latestRunsByThread,
        [event.threadId]: {
          ...existing,
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens
        }
      }
    }
  }

  if (event.type === 'run.retrying') {
    const pending = state.pendingAssistantMessages[event.runId]
    const nextThreadMessages = pending
      ? (state.messages[event.threadId] ?? []).map((message) => {
          if (message.id !== pending.messageId || message.reasoning === undefined) {
            return message
          }

          return removeReasoning(message)
        })
      : undefined

    return {
      ...(nextThreadMessages
        ? {
            messages: {
              ...state.messages,
              [event.threadId]: nextThreadMessages
            }
          }
        : {}),
      retryInfoByThread: {
        ...state.retryInfoByThread,
        [event.threadId]: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          error: event.error
        }
      }
    }
  }

  if (event.type === 'run.completed') {
    const isCurrentActiveRun = state.activeRunIdsByThread[event.threadId] === event.runId
    const pendingAssistantMessages = { ...state.pendingAssistantMessages }
    delete pendingAssistantMessages[event.runId]
    const activeRunIdsByThread = isCurrentActiveRun
      ? setThreadStringValue(state.activeRunIdsByThread, event.threadId, null)
      : state.activeRunIdsByThread
    const activeRequestMessageIdsByThread = isCurrentActiveRun
      ? setThreadStringValue(state.activeRequestMessageIdsByThread, event.threadId, null)
      : state.activeRequestMessageIdsByThread
    const retryInfoByThread = isCurrentActiveRun
      ? removeThreadRetryInfo(state.retryInfoByThread, event.threadId)
      : state.retryInfoByThread
    const existingLatestRun =
      state.latestRunsByThread[event.threadId]?.id === event.runId
        ? state.latestRunsByThread[event.threadId]
        : undefined

    const nextState = {
      ...state,
      activeRequestMessageIdsByThread,
      activeRunIdsByThread,
      retryInfoByThread,
      latestRunsByThread: upsertLatestRun(state.latestRunsByThread, {
        id: event.runId,
        threadId: event.threadId,
        status: 'completed',
        createdAt: existingLatestRun?.createdAt ?? event.timestamp,
        requestMessageId: event.requestMessageId ?? existingLatestRun?.requestMessageId,
        recalledMemoryEntries: existingLatestRun?.recalledMemoryEntries,
        recallDecision: existingLatestRun?.recallDecision,
        contextSources: existingLatestRun?.contextSources,
        runMode: existingLatestRun?.runMode,
        completedAt: event.timestamp,
        ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}),
        ...(event.completionTokens !== undefined
          ? { completionTokens: event.completionTokens }
          : {}),
        ...(event.totalPromptTokens !== undefined
          ? { totalPromptTokens: event.totalPromptTokens }
          : {}),
        ...(event.totalCompletionTokens !== undefined
          ? { totalCompletionTokens: event.totalCompletionTokens }
          : {})
      }),
      runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
        ...run,
        id: event.runId,
        threadId: event.threadId,
        status: 'completed',
        createdAt: run?.createdAt ?? event.timestamp,
        requestMessageId: event.requestMessageId ?? run?.requestMessageId,
        recalledMemoryEntries: run?.recalledMemoryEntries,
        recallDecision: run?.recallDecision,
        contextSources: run?.contextSources,
        runMode: run?.runMode,
        completedAt: event.timestamp,
        ...(event.promptTokens !== undefined ? { promptTokens: event.promptTokens } : {}),
        ...(event.completionTokens !== undefined
          ? { completionTokens: event.completionTokens }
          : {}),
        ...(event.totalPromptTokens !== undefined
          ? { totalPromptTokens: event.totalPromptTokens }
          : {}),
        ...(event.totalCompletionTokens !== undefined
          ? { totalCompletionTokens: event.totalCompletionTokens }
          : {})
      })),
      pendingAssistantMessages,
      pendingSteerMessages: isCurrentActiveRun
        ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
        : state.pendingSteerMessages,
      justDoneRunIdsByThread:
        isCurrentActiveRun && event.threadId !== state.activeThreadId && !event.recap
          ? setThreadStringValue(state.justDoneRunIdsByThread, event.threadId, event.runId)
          : state.justDoneRunIdsByThread,
      receivingModelOutputByThread: isCurrentActiveRun
        ? { ...state.receivingModelOutputByThread, [event.threadId]: false }
        : state.receivingModelOutputByThread,
      runPhasesByThread: isCurrentActiveRun
        ? setThreadRunPhaseValue(state.runPhasesByThread, event.threadId, 'idle')
        : state.runPhasesByThread,
      runStatusesByThread: isCurrentActiveRun
        ? setThreadRunStatusValue(state.runStatusesByThread, event.threadId, 'idle')
        : state.runStatusesByThread
    }

    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'run.failed') {
    const isCurrentActiveRun = state.activeRunIdsByThread[event.threadId] === event.runId
    const pending = state.pendingAssistantMessages[event.runId]
    const pendingAssistantMessages = { ...state.pendingAssistantMessages }
    delete pendingAssistantMessages[event.runId]
    const activeRunIdsByThread = isCurrentActiveRun
      ? setThreadStringValue(state.activeRunIdsByThread, event.threadId, null)
      : state.activeRunIdsByThread
    const activeRequestMessageIdsByThread = isCurrentActiveRun
      ? setThreadStringValue(state.activeRequestMessageIdsByThread, event.threadId, null)
      : state.activeRequestMessageIdsByThread
    const retryInfoByThread = isCurrentActiveRun
      ? removeThreadRetryInfo(state.retryInfoByThread, event.threadId)
      : state.retryInfoByThread
    const existingLatestRun =
      state.latestRunsByThread[event.threadId]?.id === event.runId
        ? state.latestRunsByThread[event.threadId]
        : undefined

    const nextState = {
      ...state,
      activeRequestMessageIdsByThread,
      retryInfoByThread,
      activeRunIdsByThread,
      lastError: event.error,
      latestRunsByThread: upsertLatestRun(state.latestRunsByThread, {
        id: event.runId,
        threadId: event.threadId,
        status: 'failed',
        error: event.error,
        createdAt: existingLatestRun?.createdAt ?? event.timestamp,
        requestMessageId: event.requestMessageId ?? existingLatestRun?.requestMessageId,
        recalledMemoryEntries: existingLatestRun?.recalledMemoryEntries,
        recallDecision: existingLatestRun?.recallDecision,
        contextSources: existingLatestRun?.contextSources,
        runMode: existingLatestRun?.runMode,
        completedAt: event.timestamp,
        ...(existingLatestRun?.promptTokens !== undefined
          ? { promptTokens: existingLatestRun.promptTokens }
          : {}),
        ...(existingLatestRun?.completionTokens !== undefined
          ? { completionTokens: existingLatestRun.completionTokens }
          : {}),
        ...(existingLatestRun?.totalPromptTokens !== undefined
          ? { totalPromptTokens: existingLatestRun.totalPromptTokens }
          : {}),
        ...(existingLatestRun?.totalCompletionTokens !== undefined
          ? { totalCompletionTokens: existingLatestRun.totalCompletionTokens }
          : {})
      }),
      runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
        ...run,
        id: event.runId,
        threadId: event.threadId,
        status: 'failed',
        error: event.error,
        createdAt: run?.createdAt ?? event.timestamp,
        requestMessageId: event.requestMessageId ?? run?.requestMessageId,
        recalledMemoryEntries: run?.recalledMemoryEntries,
        recallDecision: run?.recallDecision,
        contextSources: run?.contextSources,
        runMode: run?.runMode,
        completedAt: event.timestamp
      })),
      messages: pending
        ? {
            ...state.messages,
            [pending.threadId]: finalizePendingMessage(
              state.messages[pending.threadId] ?? [],
              pending,
              'failed'
            )
          }
        : state.messages,
      pendingAssistantMessages,
      pendingSteerMessages: isCurrentActiveRun
        ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
        : state.pendingSteerMessages,
      toolCalls: terminateRunToolCalls(
        state.toolCalls,
        event.threadId,
        event.runId,
        pending?.messageId
      ),
      receivingModelOutputByThread: isCurrentActiveRun
        ? { ...state.receivingModelOutputByThread, [event.threadId]: false }
        : state.receivingModelOutputByThread,
      runPhasesByThread: isCurrentActiveRun
        ? setThreadRunPhaseValue(state.runPhasesByThread, event.threadId, 'idle')
        : state.runPhasesByThread,
      runStatusesByThread: isCurrentActiveRun
        ? setThreadRunStatusValue(state.runStatusesByThread, event.threadId, 'failed')
        : state.runStatusesByThread
    }

    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'run.cancelled') {
    const isCurrentActiveRun = state.activeRunIdsByThread[event.threadId] === event.runId
    const pending = state.pendingAssistantMessages[event.runId]
    const pendingAssistantMessages = { ...state.pendingAssistantMessages }
    delete pendingAssistantMessages[event.runId]
    const activeRunIdsByThread = isCurrentActiveRun
      ? setThreadStringValue(state.activeRunIdsByThread, event.threadId, null)
      : state.activeRunIdsByThread
    const activeRequestMessageIdsByThread = isCurrentActiveRun
      ? setThreadStringValue(state.activeRequestMessageIdsByThread, event.threadId, null)
      : state.activeRequestMessageIdsByThread
    const retryInfoByThread = isCurrentActiveRun
      ? removeThreadRetryInfo(state.retryInfoByThread, event.threadId)
      : state.retryInfoByThread
    const existingLatestRun =
      state.latestRunsByThread[event.threadId]?.id === event.runId
        ? state.latestRunsByThread[event.threadId]
        : undefined

    const nextState = {
      ...state,
      activeRequestMessageIdsByThread,
      activeRunIdsByThread,
      retryInfoByThread,
      latestRunsByThread: upsertLatestRun(state.latestRunsByThread, {
        id: event.runId,
        threadId: event.threadId,
        status: 'cancelled',
        createdAt: existingLatestRun?.createdAt ?? event.timestamp,
        requestMessageId: event.requestMessageId ?? existingLatestRun?.requestMessageId,
        recalledMemoryEntries: existingLatestRun?.recalledMemoryEntries,
        recallDecision: existingLatestRun?.recallDecision,
        contextSources: existingLatestRun?.contextSources,
        runMode: existingLatestRun?.runMode,
        completedAt: event.timestamp,
        ...(existingLatestRun?.promptTokens !== undefined
          ? { promptTokens: existingLatestRun.promptTokens }
          : {}),
        ...(existingLatestRun?.completionTokens !== undefined
          ? { completionTokens: existingLatestRun.completionTokens }
          : {}),
        ...(existingLatestRun?.totalPromptTokens !== undefined
          ? { totalPromptTokens: existingLatestRun.totalPromptTokens }
          : {}),
        ...(existingLatestRun?.totalCompletionTokens !== undefined
          ? { totalCompletionTokens: existingLatestRun.totalCompletionTokens }
          : {})
      }),
      runsByThread: updateRunRecord(state.runsByThread, event.threadId, event.runId, (run) => ({
        ...run,
        id: event.runId,
        threadId: event.threadId,
        status: 'cancelled',
        createdAt: run?.createdAt ?? event.timestamp,
        requestMessageId: event.requestMessageId ?? run?.requestMessageId,
        recalledMemoryEntries: run?.recalledMemoryEntries,
        recallDecision: run?.recallDecision,
        contextSources: run?.contextSources,
        runMode: run?.runMode,
        completedAt: event.timestamp
      })),
      messages: pending
        ? {
            ...state.messages,
            [pending.threadId]: finalizePendingMessage(
              state.messages[pending.threadId] ?? [],
              pending,
              'stopped',
              { preserveEmpty: true }
            )
          }
        : state.messages,
      pendingAssistantMessages,
      pendingSteerMessages: isCurrentActiveRun
        ? removePendingSteerMessage(state.pendingSteerMessages, event.threadId)
        : state.pendingSteerMessages,
      toolCalls: terminateRunToolCalls(
        state.toolCalls,
        event.threadId,
        event.runId,
        pending?.messageId
      ),
      receivingModelOutputByThread: isCurrentActiveRun
        ? { ...state.receivingModelOutputByThread, [event.threadId]: false }
        : state.receivingModelOutputByThread,
      runPhasesByThread: isCurrentActiveRun
        ? setThreadRunPhaseValue(state.runPhasesByThread, event.threadId, 'idle')
        : state.runPhasesByThread,
      runStatusesByThread: isCurrentActiveRun
        ? setThreadRunStatusValue(state.runStatusesByThread, event.threadId, 'cancelled')
        : state.runStatusesByThread
    }

    return {
      ...nextState,
      ...deriveActiveThreadRunState(nextState)
    }
  }

  if (event.type === 'subagent.started') {
    const existing = state.subagentStateById[event.delegationId]
    const hadActiveDelegates = (state.subagentActiveIdsByThread[event.threadId]?.length ?? 0) > 0
    return {
      subagentActiveIdsByThread: upsertActiveSubagentId(
        state.subagentActiveIdsByThread,
        event.threadId,
        event.delegationId
      ),
      subagentProgressTimelineByThread: hadActiveDelegates
        ? state.subagentProgressTimelineByThread
        : {
            ...state.subagentProgressTimelineByThread,
            [event.threadId]: []
          },
      subagentStateById: {
        ...state.subagentStateById,
        [event.delegationId]: {
          delegationId: event.delegationId,
          threadId: event.threadId,
          agentName: event.agentName,
          progress: existing?.progress ?? '',
          workspacePath: event.workspacePath
        }
      }
    }
  }

  if (event.type === 'subagent.progress') {
    const existing = state.subagentStateById[event.delegationId]
    const agentName = existing?.agentName ?? 'Coding agent'
    return {
      subagentActiveIdsByThread: upsertActiveSubagentId(
        state.subagentActiveIdsByThread,
        event.threadId,
        event.delegationId
      ),
      subagentProgressTimelineByThread: appendSubagentProgressEntry(
        state.subagentProgressTimelineByThread,
        event.threadId,
        {
          delegationId: event.delegationId,
          agentName,
          chunk: event.chunk
        }
      ),
      subagentStateById: {
        ...state.subagentStateById,
        [event.delegationId]: {
          delegationId: event.delegationId,
          threadId: event.threadId,
          agentName,
          progress: (existing?.progress ?? '') + event.chunk,
          ...(existing?.workspacePath ? { workspacePath: existing.workspacePath } : {})
        }
      }
    }
  }

  if (event.type === 'subagent.finished') {
    const subagentStateById = { ...state.subagentStateById }
    delete subagentStateById[event.delegationId]
    const subagentActiveIdsByThread = removeActiveSubagentId(
      state.subagentActiveIdsByThread,
      event.threadId,
      event.delegationId
    )
    const subagentProgressTimelineByThread = { ...state.subagentProgressTimelineByThread }
    if ((subagentActiveIdsByThread[event.threadId]?.length ?? 0) === 0) {
      delete subagentProgressTimelineByThread[event.threadId]
    }
    return {
      subagentActiveIdsByThread,
      subagentProgressTimelineByThread,
      subagentStateById
    }
  }

  if (event.type === 'folder.created' || event.type === 'folder.updated') {
    return { folders: upsertFolder(state.folders, event.folder) }
  }

  if (event.type === 'folder.deleted') {
    const nextCollapsed = new Set(state.collapsedFolderIds)
    nextCollapsed.delete(event.folderId)
    saveCollapsedFolderIds(nextCollapsed)
    return {
      folders: removeFolder(state.folders, event.folderId),
      collapsedFolderIds: nextCollapsed
    }
  }

  return {}
}
