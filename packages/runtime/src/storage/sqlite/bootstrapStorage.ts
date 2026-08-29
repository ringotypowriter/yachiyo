import { and, desc, eq, inArray, isNull, like } from 'drizzle-orm'

import {
  groupLatestRunsByThread,
  toRunRecord,
  toThreadRecord,
  type YachiyoStorage
} from '../storage.ts'
import { channelUsersTable, threadFoldersTable, threadsTable } from './schema.ts'
import type { BetterSqlite3Client, SqliteDb } from './sqliteRuntime.ts'

type StoredRunRow = Parameters<typeof toRunRecord>[0]

export function selectLatestRunRows(client: Pick<BetterSqlite3Client, 'prepare'>): StoredRunRow[] {
  return client
    .prepare(
      `WITH ranked_runs AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY thread_id
                  ORDER BY created_at DESC, id DESC
                ) AS recency_rank
         FROM runs
       )
       SELECT id,
              thread_id AS threadId,
              request_message_id AS requestMessageId,
              assistant_message_id AS assistantMessageId,
              status,
              error,
              created_at AS createdAt,
              completed_at AS completedAt,
              prompt_tokens AS promptTokens,
              completion_tokens AS completionTokens,
              total_prompt_tokens AS totalPromptTokens,
              total_completion_tokens AS totalCompletionTokens,
              time_to_first_token_ms AS timeToFirstTokenMs,
              model_generation_duration_ms AS modelGenerationDurationMs,
              cache_read_tokens AS cacheReadTokens,
              cache_write_tokens AS cacheWriteTokens,
              model_id AS modelId,
              provider_name AS providerName,
              snapshot_file_count AS snapshotFileCount,
              workspace_path AS workspacePath
       FROM ranked_runs
       WHERE recency_rank = 1`
    )
    .all() as StoredRunRow[]
}

export function createSqliteBootstrapStorageMethods(input: {
  client: Pick<BetterSqlite3Client, 'prepare'>
  db: SqliteDb
}): Pick<YachiyoStorage, 'bootstrap'> {
  const { client, db } = input

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
      const channelUsers = db
        .select({ id: channelUsersTable.id, role: channelUsersTable.role })
        .from(channelUsersTable)
        .all()
      const channelUserRoles = new Map(
        channelUsers.map((row) => [row.id, row.role ?? 'guest'] as const)
      )
      const ownerUserIds = channelUsers.filter((row) => row.role === 'owner').map((row) => row.id)
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
          enabledTools: threadsTable.enabledTools,
          runMode: threadsTable.runMode,
          reasoningEffort: threadsTable.reasoningEffort,
          source: threadsTable.source,
          channelUserId: threadsTable.channelUserId,
          channelGroupId: threadsTable.channelGroupId,
          contextHandoffSummary: threadsTable.contextHandoffSummary,
          contextHandoffWatermarkMessageId: threadsTable.contextHandoffWatermarkMessageId,
          readAt: threadsTable.readAt,
          createdFromEssentialId: threadsTable.createdFromEssentialId,
          createdFromScheduleId: threadsTable.createdFromScheduleId,
          runtimeBinding: threadsTable.runtimeBinding,
          lastDelegatedSession: threadsTable.lastDelegatedSession,
          todoItems: threadsTable.todoItems,
          recapText: threadsTable.recapText,
          syncOriginDeviceId: threadsTable.syncOriginDeviceId,
          syncImportedAt: threadsTable.syncImportedAt,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt,
          workspacePath: threadsTable.workspacePath
        })
        .from(threadsTable)
        .orderBy(desc(threadsTable.updatedAt))
        .all()
      const localThreads = allThreads.filter((thread) => {
        if (
          (thread.source === null || thread.source === 'local') &&
          thread.channelUserId === null
        ) {
          return true
        }
        return (
          thread.channelGroupId === null &&
          thread.channelUserId !== null &&
          channelUserRoles.get(thread.channelUserId) === 'owner'
        )
      })
      const localThreadRecords = localThreads.map((thread) => {
        const record = toThreadRecord(thread)
        const role =
          thread.channelUserId === null ? undefined : channelUserRoles.get(thread.channelUserId)
        return role ? { ...record, channelUserRole: role } : record
      })
      const threads = localThreadRecords.filter((thread) => thread.archivedAt === undefined)
      const archivedThreads = localThreadRecords.filter((thread) => thread.archivedAt !== undefined)
      const threadIds = new Set(localThreads.map((thread) => thread.id))
      const latestRunsByThread = groupLatestRunsByThread(
        selectLatestRunRows(client)
          .filter((run) => threadIds.has(run.threadId))
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
        messagesByThread: {},
        queuedFollowUpMessagesByThread: {},
        toolCallsByThread: {}
      }
    }
  }
}
