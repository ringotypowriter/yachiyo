import { and, asc, desc, eq, inArray, isNull, like } from 'drizzle-orm'

import { sortToolCallsChronologically } from '../../../../shared/yachiyo/toolCallOrder.ts'
import {
  groupLatestRunsByThread,
  groupMessagesByThread,
  groupToolCallsByThread,
  toMessageRecord,
  toRunRecord,
  toThreadRecord,
  toToolCallRecord,
  type YachiyoStorage
} from '../storage.ts'
import {
  channelUsersTable,
  messagesTable,
  runsTable,
  threadFoldersTable,
  threadsTable,
  toolCallsTable
} from './schema.ts'
import type { SqliteDb } from './sqliteRuntime.ts'

export function createSqliteBootstrapStorageMethods(input: {
  db: SqliteDb
  isBootstrapThread: (thread: Parameters<typeof toThreadRecord>[0]) => boolean
  toThreadRecordWithChannelUserRole: (
    row: Parameters<typeof toThreadRecord>[0]
  ) => ReturnType<typeof toThreadRecord>
}): Pick<YachiyoStorage, 'bootstrap'> {
  const { db, isBootstrapThread, toThreadRecordWithChannelUserRole } = input

  return {
    bootstrap() {
      // Backfill: threads created by channels before source was persisted.
      // Their only marker is the "Channel:@user" title pattern with source still 'local'.
      db.update(threadsTable)
        .set({ source: 'telegram' })
        .where(and(like(threadsTable.title, 'Telegram:%'), eq(threadsTable.source, 'local')))
        .run()

      // Backfill: took-over threads that had source wrongly set to a channel platform.
      // Owner DM threads without a group are local; clear the stale source.
      const ownerUserIds = db
        .select({ id: channelUsersTable.id })
        .from(channelUsersTable)
        .where(eq(channelUsersTable.role, 'owner'))
        .all()
        .map((row) => row.id)
      if (ownerUserIds.length > 0) {
        db.update(threadsTable)
          .set({ source: null })
          .where(
            and(
              inArray(threadsTable.channelUserId, ownerUserIds),
              isNull(threadsTable.channelGroupId)
            )
          )
          .run()
      }

      const allThreads = db
        .select({
          archivedAt: threadsTable.archivedAt,
          starredAt: threadsTable.starredAt,
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
          handoffFromThreadId: threadsTable.handoffFromThreadId,
          folderId: threadsTable.folderId,
          colorTag: threadsTable.colorTag,
          headMessageId: threadsTable.headMessageId,
          icon: threadsTable.icon,
          id: threadsTable.id,
          memoryRecallState: threadsTable.memoryRecallState,
          modelOverride: threadsTable.modelOverride,
          preview: threadsTable.preview,
          privacyMode: threadsTable.privacyMode,
          queuedFollowUpEnabledTools: threadsTable.queuedFollowUpEnabledTools,
          queuedFollowUpEnabledSkillNames: threadsTable.queuedFollowUpEnabledSkillNames,
          queuedFollowUpMessageId: threadsTable.queuedFollowUpMessageId,
          queuedFollowUpReasoningEffort: threadsTable.queuedFollowUpReasoningEffort,
          reasoningEffort: threadsTable.reasoningEffort,
          source: threadsTable.source,
          channelUserId: threadsTable.channelUserId,
          channelGroupId: threadsTable.channelGroupId,
          rollingSummary: threadsTable.rollingSummary,
          summaryWatermarkMessageId: threadsTable.summaryWatermarkMessageId,
          readAt: threadsTable.readAt,
          createdFromEssentialId: threadsTable.createdFromEssentialId,
          createdFromScheduleId: threadsTable.createdFromScheduleId,
          runtimeBinding: threadsTable.runtimeBinding,
          lastDelegatedSession: threadsTable.lastDelegatedSession,
          recapText: threadsTable.recapText,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt,
          workspacePath: threadsTable.workspacePath
        })
        .from(threadsTable)
        .orderBy(desc(threadsTable.updatedAt))
        .all()
      const localThreads = allThreads.filter(isBootstrapThread)
      const threads = localThreads
        .filter((thread) => thread.archivedAt === null)
        .map(toThreadRecordWithChannelUserRole)
      const archivedThreads = localThreads
        .filter((thread) => thread.archivedAt !== null)
        .map(toThreadRecordWithChannelUserRole)
      const threadIds = localThreads.map((thread) => thread.id)
      const messages =
        threadIds.length === 0
          ? []
          : db
              .select({
                attachments: messagesTable.attachments,
                content: messagesTable.content,
                createdAt: messagesTable.createdAt,
                id: messagesTable.id,
                images: messagesTable.images,
                modelId: messagesTable.modelId,
                parentMessageId: messagesTable.parentMessageId,
                providerName: messagesTable.providerName,
                reasoning: messagesTable.reasoning,
                responseMessages: messagesTable.responseMessages,
                turnContext: messagesTable.turnContext,
                visibleReply: messagesTable.visibleReply,
                senderName: messagesTable.senderName,
                senderExternalUserId: messagesTable.senderExternalUserId,
                hidden: messagesTable.hidden,
                role: messagesTable.role,
                status: messagesTable.status,
                textBlocks: messagesTable.textBlocks,
                threadId: messagesTable.threadId
              })
              .from(messagesTable)
              .where(inArray(messagesTable.threadId, threadIds))
              .orderBy(asc(messagesTable.createdAt))
              .all()
              .map(toMessageRecord)
      const toolCalls = sortToolCallsChronologically(
        threadIds.length === 0
          ? []
          : db
              .select({
                assistantMessageId: toolCallsTable.assistantMessageId,
                cwd: toolCallsTable.cwd,
                details: toolCallsTable.details,
                error: toolCallsTable.error,
                finishedAt: toolCallsTable.finishedAt,
                id: toolCallsTable.id,
                inputSummary: toolCallsTable.inputSummary,
                outputSummary: toolCallsTable.outputSummary,
                requestMessageId: toolCallsTable.requestMessageId,
                runId: toolCallsTable.runId,
                startedAt: toolCallsTable.startedAt,
                stepBudget: toolCallsTable.stepBudget,
                stepIndex: toolCallsTable.stepIndex,
                status: toolCallsTable.status,
                threadId: toolCallsTable.threadId,
                toolName: toolCallsTable.toolName
              })
              .from(toolCallsTable)
              .where(inArray(toolCallsTable.threadId, threadIds))
              .orderBy(asc(toolCallsTable.startedAt))
              .all()
              .map(toToolCallRecord)
      )
      const latestRunsByThread =
        threadIds.length === 0
          ? {}
          : groupLatestRunsByThread(
              db
                .select({
                  assistantMessageId: runsTable.assistantMessageId,
                  completedAt: runsTable.completedAt,
                  completionTokens: runsTable.completionTokens,
                  createdAt: runsTable.createdAt,
                  error: runsTable.error,
                  id: runsTable.id,
                  promptTokens: runsTable.promptTokens,
                  requestMessageId: runsTable.requestMessageId,
                  status: runsTable.status,
                  threadId: runsTable.threadId,
                  totalCompletionTokens: runsTable.totalCompletionTokens,
                  totalPromptTokens: runsTable.totalPromptTokens,
                  cacheReadTokens: runsTable.cacheReadTokens,
                  cacheWriteTokens: runsTable.cacheWriteTokens,
                  modelId: runsTable.modelId,
                  providerName: runsTable.providerName,
                  snapshotFileCount: runsTable.snapshotFileCount,
                  workspacePath: runsTable.workspacePath
                })
                .from(runsTable)
                .where(inArray(runsTable.threadId, threadIds))
                .orderBy(desc(runsTable.createdAt))
                .all()
                .map(toRunRecord)
            )

      const folders = db
        .select()
        .from(threadFoldersTable)
        .orderBy(desc(threadFoldersTable.updatedAt))
        .all()

      return {
        archivedThreads,
        folders,
        latestRunsByThread,
        threads,
        messagesByThread: groupMessagesByThread(messages),
        toolCallsByThread: groupToolCallsByThread(toolCalls)
      }
    }
  }
}
