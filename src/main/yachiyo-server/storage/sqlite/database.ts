import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, asc, desc, eq, inArray, isNotNull, isNull, like, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema.ts'
import {
  channelGroupsTable,
  channelUsersTable,
  groupMonitorBuffersTable,
  imageAltTextsTable,
  messagesTable,
  runRecoveryCheckpointsTable,
  runsTable,
  scheduleRunsTable,
  schedulesTable,
  threadsTable,
  toolCallsTable
} from './schema.ts'
import {
  groupLatestRunsByThread,
  groupToolCallsByThread,
  groupMessagesByThread,
  serializeEnabledTools,
  serializeModelOverride,
  serializeSkillNames,
  serializeMessageAttachments,
  serializeMessageImages,
  serializeMessageTextBlocks,
  serializeThreadMemoryRecallState,
  serializeRuntimeBinding,
  serializeLastDelegatedSession,
  serializeToolCallDetails,
  toRunRecoveryCheckpoint,
  toStoredRunRecoveryCheckpointRow,
  toMessageRecord,
  serializeGroupMonitorBuffer,
  parseGroupMonitorBuffer,
  serializeReasoning,
  serializeResponseMessages,
  serializeTurnContext,
  toRunRecord,
  toScheduleRecord,
  toScheduleRunRecord,
  toToolCallRecord,
  toThreadRecord,
  type CompleteRunInput,
  type CreateThreadInput,
  type DeleteMessagesInput,
  type RunRecoveryCheckpoint,
  type StartRunInput,
  type YachiyoStorage
} from '../storage.ts'
import type {
  ChannelGroupRecord,
  ChannelUserRecord,
  ChannelUserRole,
  ThreadSearchResult
} from '../../../../shared/yachiyo/protocol.ts'
import { sortToolCallsChronologically } from '../../../../shared/yachiyo/toolCallOrder.ts'

function toChannelUserRecord(row: typeof channelUsersTable.$inferSelect): ChannelUserRecord {
  return {
    id: row.id,
    platform: row.platform as ChannelUserRecord['platform'],
    externalUserId: row.externalUserId,
    username: row.username,
    label: row.label,
    status: row.status,
    role: (row.role ?? 'guest') as ChannelUserRole,
    usageLimitKTokens: row.usageLimitKTokens,
    usedKTokens: row.usedKTokens,
    workspacePath: row.workspacePath
  }
}

function toChannelGroupRecord(row: typeof channelGroupsTable.$inferSelect): ChannelGroupRecord {
  return {
    id: row.id,
    platform: row.platform as ChannelGroupRecord['platform'],
    externalGroupId: row.externalGroupId,
    name: row.name,
    label: row.label,
    status: row.status,
    workspacePath: row.workspacePath,
    createdAt: row.createdAt
  }
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./drizzle', import.meta.url))
const require = createRequire(import.meta.url)

type SqliteDb = BetterSQLite3Database<typeof schema>

interface BetterSqlite3Client {
  close(): void
  pragma(sql: string): void
}

type BetterSqlite3Constructor = new (path: string) => BetterSqlite3Client

type BetterSqlite3Module = {
  default?: BetterSqlite3Constructor
}

interface SqliteRuntime {
  BetterSqlite3: BetterSqlite3Constructor
  drizzle: (client: BetterSqlite3Client, options: { schema: typeof schema }) => SqliteDb
  migrate: (db: SqliteDb, options: { migrationsFolder: string }) => void
}

function loadSqliteRuntime(): SqliteRuntime {
  const BetterSqlite3Module = require('better-sqlite3') as
    | BetterSqlite3Constructor
    | BetterSqlite3Module
  const drizzleModule = require('drizzle-orm/better-sqlite3') as Pick<SqliteRuntime, 'drizzle'>
  const migratorModule = require('drizzle-orm/better-sqlite3/migrator') as Pick<
    SqliteRuntime,
    'migrate'
  >
  const BetterSqlite3 =
    typeof BetterSqlite3Module === 'function' ? BetterSqlite3Module : BetterSqlite3Module.default

  if (!BetterSqlite3) {
    throw new Error('Failed to load better-sqlite3 runtime')
  }

  return {
    BetterSqlite3,
    drizzle: drizzleModule.drizzle,
    migrate: migratorModule.migrate
  }
}

function toSearchPattern(query: string): string {
  return `%${query.replace(/[%_]/g, '')}%`
}

function extractSnippet(content: string, query: string, maxLength = 120): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) {
    return content.length > maxLength ? `${content.slice(0, maxLength)}…` : content
  }
  const start = Math.max(0, idx - 8)
  const end = Math.min(content.length, start + maxLength)
  const snippet = content.slice(start, end)
  return `${start > 0 ? '…' : ''}${snippet}${end < content.length ? '…' : ''}`
}

export function createSqliteYachiyoStorage(dbPath: string): YachiyoStorage {
  mkdirSync(dirname(dbPath), { recursive: true })

  const { BetterSqlite3, drizzle, migrate } = loadSqliteRuntime()
  const client = new BetterSqlite3(dbPath)
  client.pragma('journal_mode = WAL')
  client.pragma('foreign_keys = ON')

  const db = drizzle(client, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })

  return {
    close() {
      client.close()
    },

    bootstrap() {
      // Backfill: threads created by channels before source was persisted.
      // Their only marker is the "Channel:@user" title pattern with source still 'local'.
      db.update(threadsTable)
        .set({ source: 'telegram' })
        .where(and(like(threadsTable.title, 'Telegram:%'), eq(threadsTable.source, 'local')))
        .run()

      const allThreads = db
        .select({
          archivedAt: threadsTable.archivedAt,
          starredAt: threadsTable.starredAt,
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
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
          source: threadsTable.source,
          channelUserId: threadsTable.channelUserId,
          channelGroupId: threadsTable.channelGroupId,
          rollingSummary: threadsTable.rollingSummary,
          summaryWatermarkMessageId: threadsTable.summaryWatermarkMessageId,
          readAt: threadsTable.readAt,
          createdFromEssentialId: threadsTable.createdFromEssentialId,
          runtimeBinding: threadsTable.runtimeBinding,
          lastDelegatedSession: threadsTable.lastDelegatedSession,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt,
          workspacePath: threadsTable.workspacePath
        })
        .from(threadsTable)
        .orderBy(desc(threadsTable.updatedAt))
        .all()
      const localThreads = allThreads.filter(
        (thread) => (thread.source === null || thread.source === 'local') && !thread.channelUserId
      )
      const threads = localThreads
        .filter((thread) => thread.archivedAt === null)
        .map(toThreadRecord)
      const archivedThreads = localThreads
        .filter((thread) => thread.archivedAt !== null)
        .map(toThreadRecord)
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
                  totalPromptTokens: runsTable.totalPromptTokens
                })
                .from(runsTable)
                .where(inArray(runsTable.threadId, threadIds))
                .orderBy(desc(runsTable.createdAt))
                .all()
                .map(toRunRecord)
            )

      return {
        archivedThreads,
        latestRunsByThread,
        threads,
        messagesByThread: groupMessagesByThread(messages),
        toolCallsByThread: groupToolCallsByThread(toolCalls)
      }
    },

    recoverInterruptedRuns({ error, finishedAt }) {
      const recoverableRunIds = new Set(
        db
          .select({ runId: runRecoveryCheckpointsTable.runId })
          .from(runRecoveryCheckpointsTable)
          .all()
          .map((row) => row.runId)
      )
      const interruptedRuns = db
        .select({
          id: runsTable.id
        })
        .from(runsTable)
        .where(eq(runsTable.status, 'running'))
        .all()

      if (interruptedRuns.length === 0) {
        return
      }

      const interruptedRunIds = interruptedRuns.map((run) => run.id)
      const failedRunIds = interruptedRunIds.filter((runId) => !recoverableRunIds.has(runId))

      db.transaction((tx) => {
        if (failedRunIds.length > 0) {
          tx.update(runsTable)
            .set({
              completedAt: finishedAt,
              error,
              status: 'failed'
            })
            .where(inArray(runsTable.id, failedRunIds))
            .run()
        }

        tx.update(toolCallsTable)
          .set({
            error: 'Tool execution was interrupted before completion.',
            finishedAt,
            outputSummary: 'Tool execution was interrupted before completion.',
            status: 'failed'
          })
          .where(
            and(
              inArray(toolCallsTable.runId, interruptedRunIds),
              eq(toolCallsTable.status, 'running')
            )
          )
          .run()
      })
    },

    listRunRecoveryCheckpoints() {
      return db
        .select()
        .from(runRecoveryCheckpointsTable)
        .orderBy(asc(runRecoveryCheckpointsTable.updatedAt))
        .all()
        .map(toRunRecoveryCheckpoint)
    },

    getRunRecoveryCheckpoint(runId) {
      const checkpoint = db
        .select()
        .from(runRecoveryCheckpointsTable)
        .where(eq(runRecoveryCheckpointsTable.runId, runId))
        .get()
      return checkpoint ? toRunRecoveryCheckpoint(checkpoint) : undefined
    },

    upsertRunRecoveryCheckpoint(checkpoint) {
      db.insert(runRecoveryCheckpointsTable)
        .values(toStoredRunRecoveryCheckpointRow(checkpoint as RunRecoveryCheckpoint))
        .onConflictDoUpdate({
          target: runRecoveryCheckpointsTable.runId,
          set: toStoredRunRecoveryCheckpointRow(checkpoint as RunRecoveryCheckpoint)
        })
        .run()
    },

    deleteRunRecoveryCheckpoint(runId) {
      db.delete(runRecoveryCheckpointsTable)
        .where(eq(runRecoveryCheckpointsTable.runId, runId))
        .run()
    },

    getRun(runId) {
      const run = db.select().from(runsTable).where(eq(runsTable.id, runId)).get()

      return run ? toRunRecord(run) : undefined
    },

    getThread(threadId) {
      const thread = db
        .select({
          archivedAt: threadsTable.archivedAt,
          starredAt: threadsTable.starredAt,
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
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
          source: threadsTable.source,
          channelUserId: threadsTable.channelUserId,
          channelGroupId: threadsTable.channelGroupId,
          rollingSummary: threadsTable.rollingSummary,
          summaryWatermarkMessageId: threadsTable.summaryWatermarkMessageId,
          readAt: threadsTable.readAt,
          createdFromEssentialId: threadsTable.createdFromEssentialId,
          runtimeBinding: threadsTable.runtimeBinding,
          lastDelegatedSession: threadsTable.lastDelegatedSession,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt,
          workspacePath: threadsTable.workspacePath
        })
        .from(threadsTable)
        .where(and(eq(threadsTable.id, threadId), isNull(threadsTable.archivedAt)))
        .get()

      return thread ? toThreadRecord(thread) : undefined
    },

    getArchivedThread(threadId) {
      const thread = db
        .select({
          archivedAt: threadsTable.archivedAt,
          starredAt: threadsTable.starredAt,
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
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
          source: threadsTable.source,
          channelUserId: threadsTable.channelUserId,
          channelGroupId: threadsTable.channelGroupId,
          rollingSummary: threadsTable.rollingSummary,
          summaryWatermarkMessageId: threadsTable.summaryWatermarkMessageId,
          readAt: threadsTable.readAt,
          createdFromEssentialId: threadsTable.createdFromEssentialId,
          runtimeBinding: threadsTable.runtimeBinding,
          lastDelegatedSession: threadsTable.lastDelegatedSession,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt,
          workspacePath: threadsTable.workspacePath
        })
        .from(threadsTable)
        .where(eq(threadsTable.id, threadId))
        .get()

      if (!thread || thread.archivedAt === null) {
        return undefined
      }

      return toThreadRecord(thread)
    },

    getThreadCreatedAt(threadId) {
      const thread = db
        .select({
          archivedAt: threadsTable.archivedAt,
          createdAt: threadsTable.createdAt
        })
        .from(threadsTable)
        .where(eq(threadsTable.id, threadId))
        .get()

      if (!thread || thread.archivedAt !== null) {
        return undefined
      }

      return thread.createdAt
    },

    createThread({ thread, createdAt, messages }: CreateThreadInput) {
      db.transaction((tx) => {
        tx.insert(threadsTable)
          .values({
            archivedAt: null,
            starredAt: null,
            branchFromMessageId: thread.branchFromMessageId ?? null,
            branchFromThreadId: thread.branchFromThreadId ?? null,
            createdAt,
            headMessageId: thread.headMessageId ?? null,
            icon: thread.icon ?? null,
            id: thread.id,
            memoryRecallState: serializeThreadMemoryRecallState(thread.memoryRecall),
            modelOverride: serializeModelOverride(thread.modelOverride),
            preview: thread.preview ?? null,
            privacyMode: thread.privacyMode ? '1' : null,
            queuedFollowUpEnabledTools: serializeEnabledTools(thread.queuedFollowUpEnabledTools),
            queuedFollowUpEnabledSkillNames: serializeSkillNames(
              thread.queuedFollowUpEnabledSkillNames
            ),
            queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
            source: thread.source ?? 'local',
            channelUserId: thread.channelUserId ?? null,
            channelGroupId: thread.channelGroupId ?? null,
            rollingSummary: thread.rollingSummary ?? null,
            summaryWatermarkMessageId: thread.summaryWatermarkMessageId ?? null,
            createdFromEssentialId: thread.createdFromEssentialId ?? null,
            title: thread.title,
            updatedAt: thread.updatedAt,
            workspacePath: thread.workspacePath ?? null,
            runtimeBinding: serializeRuntimeBinding(thread.runtimeBinding),
            lastDelegatedSession: serializeLastDelegatedSession(thread.lastDelegatedSession)
          })
          .run()

        if (messages && messages.length > 0) {
          tx.insert(messagesTable)
            .values(
              messages.map(
                ({
                  textBlocks,
                  reasoning,
                  attachments,
                  responseMessages,
                  turnContext,
                  ...rest
                }) => ({
                  ...rest,
                  textBlocks: serializeMessageTextBlocks(textBlocks),
                  images: serializeMessageImages(rest.images),
                  attachments: serializeMessageAttachments(attachments),
                  reasoning: serializeReasoning(reasoning),
                  responseMessages: serializeResponseMessages(responseMessages),
                  turnContext: serializeTurnContext(turnContext)
                })
              )
            )
            .run()
        }
      })
    },

    renameThread({ threadId, title, updatedAt }) {
      db.update(threadsTable)
        .set({
          title,
          updatedAt
        })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    archiveThread({ threadId, archivedAt, updatedAt, readAt }) {
      db.update(threadsTable)
        .set({
          archivedAt,
          updatedAt,
          // null = unread (system-initiated), timestamp = read (user-initiated)
          readAt: readAt ?? null
        })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    markThreadAsRead({ threadId, readAt }) {
      db.update(threadsTable).set({ readAt }).where(eq(threadsTable.id, threadId)).run()
    },

    markThreadReviewed({ threadId, reviewedAt }) {
      db.update(threadsTable)
        .set({ selfReviewedAt: reviewedAt })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    restoreThread({ threadId, updatedAt }) {
      db.update(threadsTable)
        .set({
          archivedAt: null,
          updatedAt
        })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    beginThreadSave({ threadId, savingStartedAt }) {
      db.update(threadsTable).set({ savingStartedAt }).where(eq(threadsTable.id, threadId)).run()
    },

    clearThreadSave({ threadId }) {
      db.update(threadsTable)
        .set({ savingStartedAt: null })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    recoverInterruptedSaves() {
      const recoveredThreadIds = db
        .select({ id: threadsTable.id })
        .from(threadsTable)
        .where(isNotNull(threadsTable.savingStartedAt))
        .all()
        .map((thread) => thread.id)

      if (recoveredThreadIds.length === 0) {
        return recoveredThreadIds
      }

      db.update(threadsTable)
        .set({ savingStartedAt: null })
        .where(isNotNull(threadsTable.savingStartedAt))
        .run()

      return recoveredThreadIds
    },

    deleteThread({ threadId }) {
      db.delete(threadsTable).where(eq(threadsTable.id, threadId)).run()
    },

    updateThread(thread) {
      db.update(threadsTable)
        .set({
          branchFromMessageId: thread.branchFromMessageId ?? null,
          branchFromThreadId: thread.branchFromThreadId ?? null,
          headMessageId: thread.headMessageId ?? null,
          icon: thread.icon ?? null,
          starredAt: thread.starredAt ?? null,
          memoryRecallState: serializeThreadMemoryRecallState(thread.memoryRecall),
          modelOverride: serializeModelOverride(thread.modelOverride),
          preview: thread.preview ?? null,
          privacyMode: thread.privacyMode ? '1' : null,
          queuedFollowUpEnabledTools: serializeEnabledTools(thread.queuedFollowUpEnabledTools),
          queuedFollowUpEnabledSkillNames: serializeSkillNames(
            thread.queuedFollowUpEnabledSkillNames
          ),
          queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
          channelGroupId: thread.channelGroupId ?? null,
          rollingSummary: thread.rollingSummary ?? null,
          summaryWatermarkMessageId: thread.summaryWatermarkMessageId ?? null,
          title: thread.title,
          updatedAt: thread.updatedAt,
          workspacePath: thread.workspacePath ?? null,
          runtimeBinding: serializeRuntimeBinding(thread.runtimeBinding),
          lastDelegatedSession: serializeLastDelegatedSession(thread.lastDelegatedSession)
        })
        .where(eq(threadsTable.id, thread.id))
        .run()
    },

    setThreadIcon({ threadId, icon, updatedAt }) {
      db.update(threadsTable).set({ icon, updatedAt }).where(eq(threadsTable.id, threadId)).run()
    },

    starThread({ threadId, starredAt }) {
      db.update(threadsTable).set({ starredAt }).where(eq(threadsTable.id, threadId)).run()
    },

    setThreadPrivacyMode({ threadId, privacyMode, updatedAt }) {
      db.update(threadsTable)
        .set({
          privacyMode: privacyMode ? '1' : null,
          updatedAt
        })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    saveThreadMessage({ thread, updatedThread, message, replacedMessageId }) {
      db.transaction((tx) => {
        if (replacedMessageId) {
          tx.delete(messagesTable).where(eq(messagesTable.id, replacedMessageId)).run()
        }

        const {
          textBlocks,
          reasoning,
          attachments,
          responseMessages,
          turnContext,
          ...persistedMessage
        } = message
        tx.insert(messagesTable)
          .values({
            ...persistedMessage,
            textBlocks: serializeMessageTextBlocks(textBlocks),
            images: serializeMessageImages(message.images),
            attachments: serializeMessageAttachments(attachments),
            reasoning: serializeReasoning(reasoning),
            responseMessages: serializeResponseMessages(responseMessages),
            turnContext: serializeTurnContext(turnContext)
          })
          .run()

        tx.update(threadsTable)
          .set({
            branchFromMessageId: updatedThread.branchFromMessageId ?? null,
            branchFromThreadId: updatedThread.branchFromThreadId ?? null,
            headMessageId: updatedThread.headMessageId ?? null,
            memoryRecallState: serializeThreadMemoryRecallState(updatedThread.memoryRecall),
            preview: updatedThread.preview ?? null,
            queuedFollowUpEnabledTools: serializeEnabledTools(
              updatedThread.queuedFollowUpEnabledTools
            ),
            queuedFollowUpEnabledSkillNames: serializeSkillNames(
              updatedThread.queuedFollowUpEnabledSkillNames
            ),
            queuedFollowUpMessageId: updatedThread.queuedFollowUpMessageId ?? null,
            title: updatedThread.title,
            updatedAt: updatedThread.updatedAt,
            workspacePath: updatedThread.workspacePath ?? null
          })
          .where(eq(threadsTable.id, thread.id))
          .run()
      })
    },

    startRun({
      runId,
      thread,
      updatedThread,
      requestMessageId,
      userMessage,
      createdAt
    }: StartRunInput) {
      db.transaction((tx) => {
        if (userMessage) {
          const {
            textBlocks,
            reasoning,
            attachments,
            responseMessages,
            turnContext,
            ...persistedUserMessage
          } = userMessage
          tx.insert(messagesTable)
            .values({
              ...persistedUserMessage,
              textBlocks: serializeMessageTextBlocks(textBlocks),
              images: serializeMessageImages(userMessage.images),
              attachments: serializeMessageAttachments(attachments),
              reasoning: serializeReasoning(reasoning),
              responseMessages: serializeResponseMessages(responseMessages),
              turnContext: serializeTurnContext(turnContext)
            })
            .run()
        }

        tx.update(threadsTable)
          .set({
            headMessageId: updatedThread.headMessageId ?? null,
            memoryRecallState: serializeThreadMemoryRecallState(updatedThread.memoryRecall),
            preview: updatedThread.preview ?? null,
            queuedFollowUpEnabledTools: serializeEnabledTools(
              updatedThread.queuedFollowUpEnabledTools
            ),
            queuedFollowUpEnabledSkillNames: serializeSkillNames(
              updatedThread.queuedFollowUpEnabledSkillNames
            ),
            queuedFollowUpMessageId: updatedThread.queuedFollowUpMessageId ?? null,
            title: updatedThread.title,
            updatedAt: updatedThread.updatedAt,
            workspacePath: updatedThread.workspacePath ?? null
          })
          .where(eq(threadsTable.id, thread.id))
          .run()

        tx.insert(runsTable)
          .values({
            assistantMessageId: null,
            completedAt: null,
            createdAt,
            error: null,
            id: runId,
            requestMessageId,
            status: 'running',
            threadId: thread.id
          })
          .run()
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
      db.transaction((tx) => {
        tx.delete(runRecoveryCheckpointsTable)
          .where(eq(runRecoveryCheckpointsTable.runId, runId))
          .run()

        const {
          textBlocks,
          reasoning,
          attachments,
          responseMessages,
          turnContext,
          ...persistedAssistantMessage
        } = assistantMessage
        tx.insert(messagesTable)
          .values({
            ...persistedAssistantMessage,
            textBlocks: serializeMessageTextBlocks(textBlocks),
            images: serializeMessageImages(assistantMessage.images),
            attachments: serializeMessageAttachments(attachments),
            reasoning: serializeReasoning(reasoning),
            responseMessages: serializeResponseMessages(responseMessages),
            turnContext: serializeTurnContext(turnContext)
          })
          .run()

        tx.update(threadsTable)
          .set({
            headMessageId: updatedThread.headMessageId ?? null,
            memoryRecallState: serializeThreadMemoryRecallState(updatedThread.memoryRecall),
            preview: updatedThread.preview ?? null,
            queuedFollowUpEnabledTools: serializeEnabledTools(
              updatedThread.queuedFollowUpEnabledTools
            ),
            queuedFollowUpEnabledSkillNames: serializeSkillNames(
              updatedThread.queuedFollowUpEnabledSkillNames
            ),
            queuedFollowUpMessageId: updatedThread.queuedFollowUpMessageId ?? null,
            runtimeBinding: serializeRuntimeBinding(updatedThread.runtimeBinding),
            lastDelegatedSession: serializeLastDelegatedSession(updatedThread.lastDelegatedSession),
            title: updatedThread.title,
            updatedAt: updatedThread.updatedAt,
            workspacePath: updatedThread.workspacePath ?? null
          })
          .where(eq(threadsTable.id, updatedThread.id))
          .run()

        tx.update(runsTable)
          .set({
            assistantMessageId: assistantMessage.id,
            completedAt: updatedThread.updatedAt,
            status: 'completed',
            ...(promptTokens !== undefined ? { promptTokens } : {}),
            ...(completionTokens !== undefined ? { completionTokens } : {}),
            ...(totalPromptTokens !== undefined ? { totalPromptTokens } : {}),
            ...(totalCompletionTokens !== undefined ? { totalCompletionTokens } : {})
          })
          .where(eq(runsTable.id, runId))
          .run()

        tx.update(toolCallsTable)
          .set({
            assistantMessageId: assistantMessage.id
          })
          .where(and(eq(toolCallsTable.runId, runId), isNull(toolCallsTable.assistantMessageId)))
          .run()
      })
    },

    cancelRun({ runId, completedAt }) {
      db.delete(runRecoveryCheckpointsTable)
        .where(eq(runRecoveryCheckpointsTable.runId, runId))
        .run()

      db.update(runsTable)
        .set({
          completedAt,
          status: 'cancelled'
        })
        .where(eq(runsTable.id, runId))
        .run()

      db.update(toolCallsTable)
        .set({ status: 'failed', finishedAt: completedAt })
        .where(and(eq(toolCallsTable.runId, runId), eq(toolCallsTable.status, 'running')))
        .run()
    },

    failRun({ runId, completedAt, error }) {
      db.delete(runRecoveryCheckpointsTable)
        .where(eq(runRecoveryCheckpointsTable.runId, runId))
        .run()

      db.update(runsTable)
        .set({
          completedAt,
          error,
          status: 'failed'
        })
        .where(eq(runsTable.id, runId))
        .run()

      db.update(toolCallsTable)
        .set({ status: 'failed', finishedAt: completedAt })
        .where(and(eq(toolCallsTable.runId, runId), eq(toolCallsTable.status, 'running')))
        .run()
    },

    listThreadMessages(threadId) {
      return db
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
        .where(eq(messagesTable.threadId, threadId))
        .orderBy(asc(messagesTable.createdAt))
        .all()
        .map(toMessageRecord)
    },

    updateMessage(message) {
      db.update(messagesTable)
        .set({
          content: message.content,
          images: serializeMessageImages(message.images),
          reasoning: serializeReasoning(message.reasoning),
          responseMessages: serializeResponseMessages(message.responseMessages),
          turnContext: serializeTurnContext(message.turnContext),
          visibleReply: message.visibleReply ?? null,
          textBlocks: serializeMessageTextBlocks(message.textBlocks),
          modelId: message.modelId ?? null,
          parentMessageId: message.parentMessageId ?? null,
          providerName: message.providerName ?? null,
          role: message.role,
          status: message.status
        })
        .where(eq(messagesTable.id, message.id))
        .run()
    },

    listThreadToolCalls(threadId) {
      return sortToolCallsChronologically(
        db
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
          .where(eq(toolCallsTable.threadId, threadId))
          .orderBy(asc(toolCallsTable.startedAt))
          .all()
          .map(toToolCallRecord)
      )
    },

    createToolCall(toolCall) {
      db.insert(toolCallsTable)
        .values({
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
        .run()
    },

    updateToolCall(toolCall) {
      db.update(toolCallsTable)
        .set({
          assistantMessageId: toolCall.assistantMessageId ?? null,
          cwd: toolCall.cwd ?? null,
          details: serializeToolCallDetails(toolCall.details),
          error: toolCall.error ?? null,
          finishedAt: toolCall.finishedAt ?? null,
          inputSummary: toolCall.inputSummary,
          outputSummary: toolCall.outputSummary ?? null,
          requestMessageId: toolCall.requestMessageId ?? null,
          stepBudget: toolCall.stepBudget ?? null,
          stepIndex: toolCall.stepIndex ?? null,
          status: toolCall.status
        })
        .where(eq(toolCallsTable.id, toolCall.id))
        .run()
    },

    deleteMessages({ thread, messageIds }: DeleteMessagesInput) {
      db.transaction((tx) => {
        if (messageIds.length > 0) {
          const runsToDelete = tx
            .select({
              id: runsTable.id
            })
            .from(runsTable)
            .where(
              or(
                inArray(runsTable.requestMessageId, messageIds),
                inArray(runsTable.assistantMessageId, messageIds)
              )
            )
            .all()

          if (runsToDelete.length > 0) {
            const runIdsToDelete = runsToDelete.map((run) => run.id)
            tx.delete(toolCallsTable)
              .where(
                and(
                  inArray(toolCallsTable.runId, runIdsToDelete),
                  or(
                    inArray(
                      toolCallsTable.assistantMessageId,
                      messageIds.filter((id) => id != null) as string[]
                    ),
                    isNull(toolCallsTable.assistantMessageId)
                  )
                )
              )
              .run()
            // Detach any remaining tool calls for these runs so they survive
            // the run deletion (e.g. tool calls bound to a stopped assistant
            // branch after a steer restart).
            tx.update(toolCallsTable)
              .set({ runId: null })
              .where(inArray(toolCallsTable.runId, runIdsToDelete))
              .run()
            tx.delete(runsTable).where(inArray(runsTable.id, runIdsToDelete)).run()
          }

          tx.delete(messagesTable).where(inArray(messagesTable.id, messageIds)).run()
        }

        tx.update(threadsTable)
          .set({
            headMessageId: thread.headMessageId ?? null,
            memoryRecallState: serializeThreadMemoryRecallState(thread.memoryRecall),
            preview: thread.preview ?? null,
            queuedFollowUpEnabledTools: serializeEnabledTools(thread.queuedFollowUpEnabledTools),
            queuedFollowUpEnabledSkillNames: serializeSkillNames(
              thread.queuedFollowUpEnabledSkillNames
            ),
            queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
            title: thread.title,
            updatedAt: thread.updatedAt
          })
          .where(eq(threadsTable.id, thread.id))
          .run()
      })
    },

    searchThreadsAndMessages({ query }) {
      const trimmed = query.trim()
      if (trimmed.length === 0) {
        return []
      }
      const pattern = toSearchPattern(trimmed)

      const titleMatchedIds = new Set(
        db
          .select({ id: threadsTable.id })
          .from(threadsTable)
          .where(
            and(
              isNull(threadsTable.archivedAt),
              or(like(threadsTable.title, pattern), like(threadsTable.preview, pattern))
            )
          )
          .all()
          .map((t) => t.id)
      )

      const allMessageMatches = db
        .select({
          messageId: messagesTable.id,
          threadId: messagesTable.threadId,
          content: messagesTable.content,
          threadUpdatedAt: threadsTable.updatedAt
        })
        .from(messagesTable)
        .innerJoin(threadsTable, eq(messagesTable.threadId, threadsTable.id))
        .where(
          and(
            isNull(threadsTable.archivedAt),
            like(messagesTable.content, pattern),
            isNull(messagesTable.hidden)
          )
        )
        .orderBy(desc(threadsTable.updatedAt), asc(messagesTable.createdAt))
        .all()

      const messageMatchesByThread = new Map<string, { messageId: string; content: string }[]>()
      for (const match of allMessageMatches) {
        const existing = messageMatchesByThread.get(match.threadId) ?? []
        existing.push({ messageId: match.messageId, content: match.content })
        messageMatchesByThread.set(match.threadId, existing)
      }

      const allMatchedIds = new Set([...titleMatchedIds, ...messageMatchesByThread.keys()])
      if (allMatchedIds.size === 0) {
        return []
      }

      const matchedThreads = db
        .select({
          id: threadsTable.id,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt
        })
        .from(threadsTable)
        .where(inArray(threadsTable.id, [...allMatchedIds]))
        .orderBy(desc(threadsTable.updatedAt))
        .limit(30)
        .all()

      const results: ThreadSearchResult[] = matchedThreads.map((thread) => {
        const matches = messageMatchesByThread.get(thread.id) ?? []
        return {
          threadId: thread.id,
          threadTitle: thread.title,
          threadUpdatedAt: thread.updatedAt,
          titleMatched: titleMatchedIds.has(thread.id),
          messageMatches: matches.map((m) => ({
            messageId: m.messageId,
            snippet: extractSnippet(m.content, trimmed)
          }))
        }
      })

      return results
    },

    findActiveChannelThread(channelUserId, maxAgeMs) {
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
      const rows = db
        .select()
        .from(threadsTable)
        .where(and(eq(threadsTable.channelUserId, channelUserId), isNull(threadsTable.archivedAt)))
        .orderBy(desc(threadsTable.updatedAt))
        .all()

      const row = rows.find((r) => r.updatedAt >= cutoff)
      return row ? toThreadRecord(row) : undefined
    },

    getThreadTotalTokens(threadId) {
      const row = db
        .select({ promptTokens: runsTable.promptTokens })
        .from(runsTable)
        .where(and(eq(runsTable.threadId, threadId), eq(runsTable.status, 'completed')))
        .orderBy(desc(runsTable.completedAt))
        .limit(1)
        .get()

      if (!row) return 0
      // Last step's prompt tokens = actual context window size.
      return row.promptTokens ?? 0
    },

    listExternalThreads() {
      return db
        .select()
        .from(threadsTable)
        .where(and(isNotNull(threadsTable.source), isNull(threadsTable.archivedAt)))
        .orderBy(desc(threadsTable.updatedAt))
        .all()
        .filter((row) => row.source !== 'local')
        .map(toThreadRecord)
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
      return row ? toThreadRecord(row) : undefined
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
