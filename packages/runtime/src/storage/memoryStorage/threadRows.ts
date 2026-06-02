import type { ThreadRecord } from '@yachiyo/shared/protocol'
import {
  serializeEnabledTools,
  serializeLastDelegatedSession,
  serializeModelOverride,
  serializeReasoningSelection,
  serializeRuntimeBinding,
  serializeTodoItems,
  serializeThreadMemoryRecallState,
  toThreadRecord,
  type StoredThreadRow
} from '../storage.ts'

export function createStoredThreadRow(thread: ThreadRecord, createdAt: string): StoredThreadRow {
  return {
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
    colorTag: thread.colorTag ?? null,
    enabledTools: serializeEnabledTools(thread.enabledTools),
    runMode: thread.runMode ?? null,
    reasoningEffort: serializeReasoningSelection(thread.reasoningEffort),
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
    createdFromScheduleId: thread.createdFromScheduleId ?? null,
    runtimeBinding: serializeRuntimeBinding(thread.runtimeBinding),
    lastDelegatedSession: serializeLastDelegatedSession(thread.lastDelegatedSession),
    todoItems: serializeTodoItems(thread.todoItems),
    recapText: thread.recapText ?? null,
    updatedAt: thread.updatedAt,
    createdAt
  }
}

export function applyThreadSnapshot(
  storedThread: StoredThreadRow,
  nextThread: ReturnType<typeof toThreadRecord>
): void {
  storedThread.branchFromThreadId = nextThread.branchFromThreadId ?? null
  storedThread.branchFromMessageId = nextThread.branchFromMessageId ?? null
  storedThread.source = nextThread.source ?? null
  storedThread.channelUserId = nextThread.channelUserId ?? null
  storedThread.channelGroupId = nextThread.channelGroupId ?? null
  storedThread.handoffFromThreadId = nextThread.handoffFromThreadId ?? null
  storedThread.folderId = nextThread.folderId ?? null
  storedThread.colorTag = nextThread.colorTag ?? null
  storedThread.headMessageId = nextThread.headMessageId ?? null
  storedThread.icon = nextThread.icon ?? null
  storedThread.memoryRecallState = serializeThreadMemoryRecallState(nextThread.memoryRecall)
  storedThread.preview = nextThread.preview ?? null
  storedThread.privacyMode = nextThread.privacyMode ? '1' : null
  storedThread.enabledTools = serializeEnabledTools(nextThread.enabledTools)
  storedThread.runMode = nextThread.runMode ?? null
  storedThread.reasoningEffort = serializeReasoningSelection(nextThread.reasoningEffort)
  storedThread.modelOverride = serializeModelOverride(nextThread.modelOverride)
  storedThread.rollingSummary = nextThread.rollingSummary ?? null
  storedThread.summaryWatermarkMessageId = nextThread.summaryWatermarkMessageId ?? null
  storedThread.runtimeBinding = serializeRuntimeBinding(nextThread.runtimeBinding)
  storedThread.lastDelegatedSession = serializeLastDelegatedSession(nextThread.lastDelegatedSession)
  storedThread.todoItems = serializeTodoItems(nextThread.todoItems)
  storedThread.recapText = nextThread.recapText ?? null
  storedThread.starredAt = nextThread.starredAt ?? null
  storedThread.title = nextThread.title
  storedThread.updatedAt = nextThread.updatedAt
  storedThread.workspacePath = nextThread.workspacePath ?? null
}
