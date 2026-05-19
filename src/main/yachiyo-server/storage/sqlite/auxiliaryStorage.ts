import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type {
  UsageStatsBucket,
  UsageStatsByModel,
  UsageStatsByWorkspace,
  UsageStatsInput,
  UsageStatsResponse
} from '../../../../shared/yachiyo/protocol.ts'
import {
  parseGroupMonitorBuffer,
  parseMessageTextBlocks,
  serializeEnabledTools,
  serializeGroupMonitorBuffer,
  serializeModelOverride,
  toScheduleRecord,
  toScheduleRunRecord,
  toThreadRecord,
  type YachiyoStorage
} from '../storage.ts'
import * as schema from './schema.ts'
import {
  channelGroupsTable,
  channelUsersTable,
  groupMonitorBuffersTable,
  imageAltTextsTable,
  messagesTable,
  runsTable,
  scheduleRunsTable,
  schedulesTable,
  threadFoldersTable,
  threadsTable
} from './schema.ts'

type SqliteDb = BetterSQLite3Database<typeof schema>

type SqliteAuxiliaryStorageMethods = Pick<
  YachiyoStorage,
  | 'listExternalThreads'
  | 'listOwnerDmTakeoverThreadCandidates'
  | 'hasVisibleThreadMessages'
  | 'listChannelUsers'
  | 'findChannelUser'
  | 'createChannelUser'
  | 'getChannelUser'
  | 'updateChannelUser'
  | 'listChannelGroups'
  | 'findChannelGroup'
  | 'getChannelGroup'
  | 'createChannelGroup'
  | 'updateChannelGroup'
  | 'findActiveGroupThread'
  | 'listThreadsByChannelGroupId'
  | 'listFolders'
  | 'getFolder'
  | 'listThreadsInFolder'
  | 'createFolder'
  | 'renameFolder'
  | 'setFolderColor'
  | 'deleteFolder'
  | 'setThreadFolder'
  | 'getImageAltText'
  | 'saveImageAltText'
  | 'listSchedules'
  | 'getSchedule'
  | 'createSchedule'
  | 'updateSchedule'
  | 'deleteSchedule'
  | 'createScheduleRun'
  | 'completeScheduleRun'
  | 'listScheduleRuns'
  | 'listRecentScheduleRuns'
  | 'getScheduleRunByThreadId'
  | 'recoverInterruptedScheduleRuns'
  | 'getUsageStats'
  | 'saveGroupMonitorBuffer'
  | 'loadGroupMonitorBuffer'
  | 'deleteGroupMonitorBuffer'
>

export function createSqliteAuxiliaryStorageMethods(input: {
  db: SqliteDb
  isBootstrapThread: (thread: Parameters<typeof toThreadRecord>[0]) => boolean
  isOwnerDmThread: (thread: {
    channelGroupId: string | null
    channelUserId: string | null
  }) => boolean
  toChannelGroupRecord: (
    row: typeof channelGroupsTable.$inferSelect
  ) => ReturnType<YachiyoStorage['createChannelGroup']>
  toChannelUserRecord: (
    row: typeof channelUsersTable.$inferSelect
  ) => ReturnType<YachiyoStorage['createChannelUser']>
  toThreadRecordWithChannelUserRole: (
    row: Parameters<typeof toThreadRecord>[0]
  ) => ReturnType<typeof toThreadRecord>
}): SqliteAuxiliaryStorageMethods {
  const {
    db,
    isBootstrapThread,
    isOwnerDmThread,
    toChannelGroupRecord,
    toChannelUserRecord,
    toThreadRecordWithChannelUserRole
  } = input

  const hasVisibleMessageText = (row: {
    content: string
    textBlocks: string | null
    visibleReply: string | null
  }): boolean => {
    if ((row.visibleReply ?? row.content).trim().length > 0) {
      return true
    }
    return (
      parseMessageTextBlocks(row.textBlocks)?.some((block) => block.content.trim().length > 0) ??
      false
    )
  }

  return {
    listExternalThreads() {
      return db
        .select()
        .from(threadsTable)
        .where(
          and(
            isNotNull(threadsTable.source),
            isNull(threadsTable.archivedAt),
            isNull(threadsTable.channelGroupId)
          )
        )
        .orderBy(desc(threadsTable.updatedAt))
        .all()
        .filter((row) => row.source !== 'local' && !isOwnerDmThread(row))
        .map(toThreadRecordWithChannelUserRole)
    },

    listOwnerDmTakeoverThreadCandidates() {
      return db
        .select()
        .from(threadsTable)
        .where(isNull(threadsTable.archivedAt))
        .orderBy(desc(threadsTable.updatedAt))
        .all()
        .filter(isBootstrapThread)
        .map(toThreadRecordWithChannelUserRole)
    },

    hasVisibleThreadMessages(threadId) {
      return db
        .select({
          content: messagesTable.content,
          textBlocks: messagesTable.textBlocks,
          visibleReply: messagesTable.visibleReply
        })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.threadId, threadId),
            inArray(messagesTable.role, ['user', 'assistant']),
            or(isNull(messagesTable.hidden), eq(messagesTable.hidden, false))
          )
        )
        .all()
        .some(hasVisibleMessageText)
    },

    listChannelUsers() {
      return db.select().from(channelUsersTable).all().map(toChannelUserRecord)
    },

    findChannelUser(platform, externalUserId) {
      const row = db
        .select()
        .from(channelUsersTable)
        .where(
          and(
            eq(channelUsersTable.platform, platform),
            eq(channelUsersTable.externalUserId, externalUserId)
          )
        )
        .get()

      if (!row) return undefined

      return toChannelUserRecord(row)
    },

    createChannelUser(user) {
      db.insert(channelUsersTable)
        .values({
          id: user.id,
          platform: user.platform,
          externalUserId: user.externalUserId,
          username: user.username,
          label: user.label ?? '',
          status: user.status,
          role: user.role,
          usageLimitKTokens: user.usageLimitKTokens,
          usedKTokens: 0,
          workspacePath: user.workspacePath
        })
        .run()

      return { ...user, usedKTokens: 0 }
    },

    getChannelUser(id) {
      const row = db.select().from(channelUsersTable).where(eq(channelUsersTable.id, id)).get()
      return row ? toChannelUserRecord(row) : undefined
    },

    updateChannelUser({ id, status, role, label, usageLimitKTokens, usedKTokens }) {
      const existing = db.select().from(channelUsersTable).where(eq(channelUsersTable.id, id)).get()

      if (!existing) return undefined

      const updates: Record<string, unknown> = {}
      if (status !== undefined) updates.status = status
      if (role !== undefined) updates.role = role
      if (label !== undefined) updates.label = label
      if (usageLimitKTokens !== undefined) updates.usageLimitKTokens = usageLimitKTokens
      if (usedKTokens !== undefined) updates.usedKTokens = usedKTokens

      if (Object.keys(updates).length > 0) {
        db.update(channelUsersTable).set(updates).where(eq(channelUsersTable.id, id)).run()
      }

      const updated = db.select().from(channelUsersTable).where(eq(channelUsersTable.id, id)).get()!

      return toChannelUserRecord(updated)
    },

    // ------------------------------------------------------------------
    // Channel groups (group discussion mode)
    // ------------------------------------------------------------------

    listChannelGroups() {
      return db.select().from(channelGroupsTable).all().map(toChannelGroupRecord)
    },

    findChannelGroup(platform, externalGroupId) {
      const row = db
        .select()
        .from(channelGroupsTable)
        .where(
          and(
            eq(channelGroupsTable.platform, platform),
            eq(channelGroupsTable.externalGroupId, externalGroupId)
          )
        )
        .get()
      return row ? toChannelGroupRecord(row) : undefined
    },

    getChannelGroup(id) {
      const row = db.select().from(channelGroupsTable).where(eq(channelGroupsTable.id, id)).get()
      return row ? toChannelGroupRecord(row) : undefined
    },

    createChannelGroup(group) {
      const createdAt = new Date().toISOString()
      db.insert(channelGroupsTable)
        .values({
          id: group.id,
          platform: group.platform,
          externalGroupId: group.externalGroupId,
          name: group.name,
          label: group.label ?? '',
          status: group.status,
          workspacePath: group.workspacePath,
          createdAt
        })
        .run()
      return { ...group, createdAt }
    },

    updateChannelGroup({ id, status, name, label }) {
      const existing = db
        .select()
        .from(channelGroupsTable)
        .where(eq(channelGroupsTable.id, id))
        .get()
      if (!existing) return undefined

      const updates: Record<string, unknown> = {}
      if (status !== undefined) updates.status = status
      if (name !== undefined) updates.name = name
      if (label !== undefined) updates.label = label

      if (Object.keys(updates).length > 0) {
        db.update(channelGroupsTable).set(updates).where(eq(channelGroupsTable.id, id)).run()
      }

      const updated = db
        .select()
        .from(channelGroupsTable)
        .where(eq(channelGroupsTable.id, id))
        .get()!
      return toChannelGroupRecord(updated)
    },

    findActiveGroupThread(channelGroupId, maxAgeMs) {
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
      const rows = db
        .select()
        .from(threadsTable)
        .where(
          and(eq(threadsTable.channelGroupId, channelGroupId), isNull(threadsTable.archivedAt))
        )
        .orderBy(desc(threadsTable.updatedAt))
        .all()

      const row = rows.find((r) => r.updatedAt >= cutoff)
      return row ? toThreadRecordWithChannelUserRole(row) : undefined
    },

    listThreadsByChannelGroupId(channelGroupId) {
      return db
        .select()
        .from(threadsTable)
        .where(eq(threadsTable.channelGroupId, channelGroupId))
        .orderBy(desc(threadsTable.updatedAt))
        .all()
        .map(toThreadRecordWithChannelUserRole)
    },

    // Thread folders
    listFolders() {
      return db.select().from(threadFoldersTable).orderBy(desc(threadFoldersTable.updatedAt)).all()
    },

    getFolder(folderId) {
      return db.select().from(threadFoldersTable).where(eq(threadFoldersTable.id, folderId)).get()
    },

    listThreadsInFolder(folderId, options) {
      return db
        .select()
        .from(threadsTable)
        .where(
          options?.includeArchived === true
            ? eq(threadsTable.folderId, folderId)
            : and(eq(threadsTable.folderId, folderId), isNull(threadsTable.archivedAt))
        )
        .orderBy(desc(threadsTable.updatedAt))
        .all()
        .filter(isBootstrapThread)
        .map(toThreadRecordWithChannelUserRole)
    },

    createFolder(folder) {
      db.insert(threadFoldersTable)
        .values({
          id: folder.id,
          title: folder.title,
          colorTag: folder.colorTag ?? null,
          createdAt: folder.createdAt,
          updatedAt: folder.updatedAt
        })
        .run()
    },

    renameFolder({ folderId, title, updatedAt }) {
      db.update(threadFoldersTable)
        .set({ title, updatedAt })
        .where(eq(threadFoldersTable.id, folderId))
        .run()
    },

    setFolderColor({ folderId, colorTag, updatedAt }) {
      db.update(threadFoldersTable)
        .set({ colorTag, updatedAt })
        .where(eq(threadFoldersTable.id, folderId))
        .run()
    },

    deleteFolder(folderId) {
      // Unset folderId on all member threads first (FK has onDelete: 'set null' but be explicit)
      db.update(threadsTable)
        .set({ folderId: null })
        .where(eq(threadsTable.folderId, folderId))
        .run()
      db.delete(threadFoldersTable).where(eq(threadFoldersTable.id, folderId)).run()
    },

    setThreadFolder({ threadId, folderId, updatedAt }) {
      db.update(threadsTable)
        .set({ folderId, updatedAt })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    getImageAltText(imageHash) {
      const row = db
        .select()
        .from(imageAltTextsTable)
        .where(eq(imageAltTextsTable.imageHash, imageHash))
        .get()
      return row ? { imageHash: row.imageHash, altText: row.altText } : undefined
    },

    saveImageAltText(imageHash, altText) {
      db.insert(imageAltTextsTable)
        .values({ imageHash, altText, createdAt: new Date().toISOString() })
        .onConflictDoNothing()
        .run()
    },

    // -----------------------------------------------------------------------
    // Schedules
    // -----------------------------------------------------------------------

    listSchedules() {
      return db
        .select()
        .from(schedulesTable)
        .orderBy(asc(schedulesTable.name))
        .all()
        .map(toScheduleRecord)
    },

    getSchedule(id) {
      const row = db.select().from(schedulesTable).where(eq(schedulesTable.id, id)).get()
      return row ? toScheduleRecord(row) : undefined
    },

    createSchedule(schedule) {
      db.insert(schedulesTable)
        .values({
          id: schedule.id,
          name: schedule.name,
          cronExpression: schedule.cronExpression ?? null,
          runAt: schedule.runAt ?? null,
          prompt: schedule.prompt,
          workspacePath: schedule.workspacePath ?? null,
          modelOverride: serializeModelOverride(schedule.modelOverride),
          enabledTools: serializeEnabledTools(schedule.enabledTools),
          enabled: schedule.enabled ? 1 : 0,
          createdAt: schedule.createdAt,
          updatedAt: schedule.updatedAt
        })
        .run()
    },

    updateSchedule(schedule) {
      db.update(schedulesTable)
        .set({
          name: schedule.name,
          cronExpression: schedule.cronExpression ?? null,
          runAt: schedule.runAt ?? null,
          prompt: schedule.prompt,
          workspacePath: schedule.workspacePath ?? null,
          modelOverride: serializeModelOverride(schedule.modelOverride),
          enabledTools: serializeEnabledTools(schedule.enabledTools),
          enabled: schedule.enabled ? 1 : 0,
          updatedAt: schedule.updatedAt
        })
        .where(eq(schedulesTable.id, schedule.id))
        .run()
    },

    deleteSchedule(id) {
      db.delete(schedulesTable).where(eq(schedulesTable.id, id)).run()
    },

    // -----------------------------------------------------------------------
    // Schedule runs
    // -----------------------------------------------------------------------

    createScheduleRun(run) {
      db.insert(scheduleRunsTable)
        .values({
          id: run.id,
          scheduleId: run.scheduleId,
          threadId: run.threadId ?? null,
          status: run.status,
          resultStatus: run.resultStatus ?? null,
          resultSummary: run.resultSummary ?? null,
          error: run.error ?? null,
          promptTokens: run.promptTokens ?? null,
          completionTokens: run.completionTokens ?? null,
          startedAt: run.startedAt,
          completedAt: run.completedAt ?? null
        })
        .run()
    },

    completeScheduleRun(input) {
      db.update(scheduleRunsTable)
        .set({
          status: input.status,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.resultStatus ? { resultStatus: input.resultStatus } : {}),
          ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
          ...(input.error ? { error: input.error } : {}),
          ...(input.promptTokens != null ? { promptTokens: input.promptTokens } : {}),
          ...(input.completionTokens != null ? { completionTokens: input.completionTokens } : {}),
          completedAt: input.completedAt
        })
        .where(eq(scheduleRunsTable.id, input.id))
        .run()
    },

    listScheduleRuns(scheduleId, limit = 50) {
      return db
        .select()
        .from(scheduleRunsTable)
        .where(eq(scheduleRunsTable.scheduleId, scheduleId))
        .orderBy(desc(scheduleRunsTable.startedAt))
        .limit(limit)
        .all()
        .map(toScheduleRunRecord)
    },

    listRecentScheduleRuns(limit = 50) {
      return db
        .select()
        .from(scheduleRunsTable)
        .orderBy(desc(scheduleRunsTable.startedAt))
        .limit(limit)
        .all()
        .map(toScheduleRunRecord)
    },

    getScheduleRunByThreadId(threadId) {
      const row = db
        .select()
        .from(scheduleRunsTable)
        .where(eq(scheduleRunsTable.threadId, threadId))
        .orderBy(desc(scheduleRunsTable.startedAt))
        .limit(1)
        .get()
      return row ? toScheduleRunRecord(row) : undefined
    },

    recoverInterruptedScheduleRuns({ completedAt, error }) {
      db.update(scheduleRunsTable)
        .set({ status: 'failed', error, completedAt })
        .where(eq(scheduleRunsTable.status, 'running'))
        .run()
    },

    // -----------------------------------------------------------------------
    // Usage statistics
    // -----------------------------------------------------------------------

    getUsageStats(input: UsageStatsInput): UsageStatsResponse {
      const periodFormats: Record<string, string> = {
        day: '%Y-%m-%d',
        week: '%Y-W%W',
        month: '%Y-%m',
        year: '%Y'
      }
      const fmt = periodFormats[input.period] ?? '%Y-%m-%d'

      const conditions = [sql`${runsTable.status} = 'completed'`]
      if (input.from) conditions.push(sql`${runsTable.completedAt} >= ${input.from}`)
      if (input.to) conditions.push(sql`${runsTable.completedAt} <= ${input.to}`)
      if (input.modelId) conditions.push(sql`${runsTable.modelId} = ${input.modelId}`)
      if (input.providerName)
        conditions.push(sql`${runsTable.providerName} = ${input.providerName}`)
      if (input.workspacePath) {
        if (input.workspacePath === '__null__') {
          conditions.push(sql`${threadsTable.workspacePath} IS NULL`)
        } else {
          conditions.push(sql`${threadsTable.workspacePath} = ${input.workspacePath}`)
        }
      }
      const whereClause = sql.join(conditions, sql` AND `)

      const needsJoin = input.workspacePath != null
      const fromClause = needsJoin
        ? sql`${runsTable} INNER JOIN ${threadsTable} ON ${runsTable.threadId} = ${threadsTable.id}`
        : sql`${runsTable}`

      // Buckets: time-series aggregation
      const bucketRows = db.all<{
        period_start: string
        total_prompt: number
        total_completion: number
        total_cache_read: number
        total_cache_write: number
        cache_aware_prompt: number
        run_count: number
      }>(sql`
        SELECT
          strftime(${fmt}, ${runsTable.completedAt}) AS period_start,
          COALESCE(SUM(${runsTable.totalPromptTokens}), 0) AS total_prompt,
          COALESCE(SUM(${runsTable.totalCompletionTokens}), 0) AS total_completion,
          COALESCE(SUM(${runsTable.cacheReadTokens}), 0) AS total_cache_read,
          COALESCE(SUM(${runsTable.cacheWriteTokens}), 0) AS total_cache_write,
          COALESCE(SUM(CASE WHEN ${runsTable.cacheReadTokens} IS NOT NULL THEN ${runsTable.totalPromptTokens} ELSE 0 END), 0) AS cache_aware_prompt,
          COUNT(*) AS run_count
        FROM ${fromClause}
        WHERE ${whereClause}
        GROUP BY period_start
        ORDER BY period_start ASC
      `)

      const buckets: UsageStatsBucket[] = bucketRows.map((r) => ({
        periodStart: r.period_start,
        totalPromptTokens: r.total_prompt,
        totalCompletionTokens: r.total_completion,
        totalCacheReadTokens: r.total_cache_read,
        totalCacheWriteTokens: r.total_cache_write,
        cacheAwarePromptTokens: r.cache_aware_prompt,
        runCount: r.run_count
      }))

      // By model
      const modelRows = db.all<{
        model_id: string | null
        provider_name: string | null
        total_prompt: number
        total_completion: number
        total_cache_read: number
        total_cache_write: number
        cache_aware_prompt: number
        run_count: number
      }>(sql`
        SELECT
          ${runsTable.modelId} AS model_id,
          ${runsTable.providerName} AS provider_name,
          COALESCE(SUM(${runsTable.totalPromptTokens}), 0) AS total_prompt,
          COALESCE(SUM(${runsTable.totalCompletionTokens}), 0) AS total_completion,
          COALESCE(SUM(${runsTable.cacheReadTokens}), 0) AS total_cache_read,
          COALESCE(SUM(${runsTable.cacheWriteTokens}), 0) AS total_cache_write,
          COALESCE(SUM(CASE WHEN ${runsTable.cacheReadTokens} IS NOT NULL THEN ${runsTable.totalPromptTokens} ELSE 0 END), 0) AS cache_aware_prompt,
          COUNT(*) AS run_count
        FROM ${fromClause}
        WHERE ${whereClause}
        GROUP BY ${runsTable.modelId}, ${runsTable.providerName}
        ORDER BY total_prompt DESC
      `)

      const byModel: UsageStatsByModel[] = modelRows
        .filter((r) => r.model_id != null)
        .map((r) => ({
          modelId: r.model_id!,
          providerName: r.provider_name ?? 'unknown',
          totalPromptTokens: r.total_prompt,
          totalCompletionTokens: r.total_completion,
          totalCacheReadTokens: r.total_cache_read,
          totalCacheWriteTokens: r.total_cache_write,
          cacheAwarePromptTokens: r.cache_aware_prompt,
          runCount: r.run_count
        }))

      // By workspace (always needs join)
      const wsFromClause = sql`${runsTable} INNER JOIN ${threadsTable} ON ${runsTable.threadId} = ${threadsTable.id}`
      const wsRows = db.all<{
        workspace_path: string | null
        total_prompt: number
        total_completion: number
        total_cache_read: number
        total_cache_write: number
        cache_aware_prompt: number
        run_count: number
      }>(sql`
        SELECT
          COALESCE(${threadsTable.workspacePath}, '__null__') AS workspace_path,
          COALESCE(SUM(${runsTable.totalPromptTokens}), 0) AS total_prompt,
          COALESCE(SUM(${runsTable.totalCompletionTokens}), 0) AS total_completion,
          COALESCE(SUM(${runsTable.cacheReadTokens}), 0) AS total_cache_read,
          COALESCE(SUM(${runsTable.cacheWriteTokens}), 0) AS total_cache_write,
          COALESCE(SUM(CASE WHEN ${runsTable.cacheReadTokens} IS NOT NULL THEN ${runsTable.totalPromptTokens} ELSE 0 END), 0) AS cache_aware_prompt,
          COUNT(*) AS run_count
        FROM ${wsFromClause}
        WHERE ${whereClause}
        GROUP BY ${threadsTable.workspacePath}
        ORDER BY total_prompt DESC
      `)

      const byWorkspace: UsageStatsByWorkspace[] = wsRows.map((r) => ({
        workspacePath: r.workspace_path ?? '__null__',
        totalPromptTokens: r.total_prompt,
        totalCompletionTokens: r.total_completion,
        totalCacheReadTokens: r.total_cache_read,
        totalCacheWriteTokens: r.total_cache_write,
        cacheAwarePromptTokens: r.cache_aware_prompt,
        runCount: r.run_count
      }))

      // Totals
      const totalsRow = db.get<{
        total_prompt: number
        total_completion: number
        total_cache_read: number
        total_cache_write: number
        cache_aware_prompt: number
        run_count: number
      }>(sql`
        SELECT
          COALESCE(SUM(${runsTable.totalPromptTokens}), 0) AS total_prompt,
          COALESCE(SUM(${runsTable.totalCompletionTokens}), 0) AS total_completion,
          COALESCE(SUM(${runsTable.cacheReadTokens}), 0) AS total_cache_read,
          COALESCE(SUM(${runsTable.cacheWriteTokens}), 0) AS total_cache_write,
          COALESCE(SUM(CASE WHEN ${runsTable.cacheReadTokens} IS NOT NULL THEN ${runsTable.totalPromptTokens} ELSE 0 END), 0) AS cache_aware_prompt,
          COUNT(*) AS run_count
        FROM ${fromClause}
        WHERE ${whereClause}
      `)

      return {
        buckets,
        byModel,
        byWorkspace,
        totals: {
          promptTokens: totalsRow?.total_prompt ?? 0,
          completionTokens: totalsRow?.total_completion ?? 0,
          cacheReadTokens: totalsRow?.total_cache_read ?? 0,
          cacheWriteTokens: totalsRow?.total_cache_write ?? 0,
          cacheAwarePromptTokens: totalsRow?.cache_aware_prompt ?? 0,
          runCount: totalsRow?.run_count ?? 0
        }
      }
    },

    // -----------------------------------------------------------------------
    // Group monitor buffer persistence
    // -----------------------------------------------------------------------

    saveGroupMonitorBuffer({ groupId, phase, buffer, savedAt }) {
      db.insert(groupMonitorBuffersTable)
        .values({
          groupId,
          phase,
          buffer: serializeGroupMonitorBuffer(buffer),
          savedAt
        })
        .onConflictDoUpdate({
          target: groupMonitorBuffersTable.groupId,
          set: {
            phase,
            buffer: serializeGroupMonitorBuffer(buffer),
            savedAt
          }
        })
        .run()
    },

    loadGroupMonitorBuffer(groupId) {
      const row = db
        .select()
        .from(groupMonitorBuffersTable)
        .where(eq(groupMonitorBuffersTable.groupId, groupId))
        .get()
      if (!row) return undefined
      return {
        phase: row.phase,
        buffer: parseGroupMonitorBuffer(row.buffer),
        savedAt: row.savedAt
      }
    },

    deleteGroupMonitorBuffer(groupId) {
      db.delete(groupMonitorBuffersTable).where(eq(groupMonitorBuffersTable.groupId, groupId)).run()
    }
  }
}
