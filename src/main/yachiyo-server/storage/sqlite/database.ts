import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema.ts'
import { messagesTable, runsTable, threadsTable, toolCallsTable } from './schema.ts'
import {
  groupLatestRunsByThread,
  groupToolCallsByThread,
  groupMessagesByThread,
  serializeEnabledTools,
  serializeMessageImages,
  serializeMessageTextBlocks,
  serializeThreadMemoryRecallState,
  serializeToolCallDetails,
  toMessageRecord,
  toRunRecord,
  toToolCallRecord,
  toThreadRecord,
  type CompleteRunInput,
  type CreateThreadInput,
  type DeleteMessagesInput,
  type StartRunInput,
  type YachiyoStorage
} from '../storage.ts'

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
      const allThreads = db
        .select({
          archivedAt: threadsTable.archivedAt,
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
          headMessageId: threadsTable.headMessageId,
          id: threadsTable.id,
          memoryRecallState: threadsTable.memoryRecallState,
          preview: threadsTable.preview,
          queuedFollowUpEnabledTools: threadsTable.queuedFollowUpEnabledTools,
          queuedFollowUpMessageId: threadsTable.queuedFollowUpMessageId,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt,
          workspacePath: threadsTable.workspacePath
        })
        .from(threadsTable)
        .orderBy(desc(threadsTable.updatedAt))
        .all()
      const threads = allThreads.filter((thread) => thread.archivedAt === null).map(toThreadRecord)
      const archivedThreads = allThreads
        .filter((thread) => thread.archivedAt !== null)
        .map(toThreadRecord)
      const threadIds = allThreads.map((thread) => thread.id)
      const messages =
        threadIds.length === 0
          ? []
          : db
              .select({
                content: messagesTable.content,
                createdAt: messagesTable.createdAt,
                id: messagesTable.id,
                images: messagesTable.images,
                modelId: messagesTable.modelId,
                parentMessageId: messagesTable.parentMessageId,
                providerName: messagesTable.providerName,
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
      const toolCalls =
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
                status: toolCallsTable.status,
                threadId: toolCallsTable.threadId,
                toolName: toolCallsTable.toolName
              })
              .from(toolCallsTable)
              .where(inArray(toolCallsTable.threadId, threadIds))
              .orderBy(asc(toolCallsTable.startedAt))
              .all()
              .map(toToolCallRecord)
      const latestRunsByThread =
        threadIds.length === 0
          ? {}
          : groupLatestRunsByThread(
              db
                .select({
                  assistantMessageId: runsTable.assistantMessageId,
                  completedAt: runsTable.completedAt,
                  createdAt: runsTable.createdAt,
                  error: runsTable.error,
                  id: runsTable.id,
                  requestMessageId: runsTable.requestMessageId,
                  status: runsTable.status,
                  threadId: runsTable.threadId
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

      db.transaction((tx) => {
        tx.update(runsTable)
          .set({
            completedAt: finishedAt,
            error,
            status: 'failed'
          })
          .where(inArray(runsTable.id, interruptedRunIds))
          .run()

        tx.update(toolCallsTable)
          .set({
            error,
            finishedAt,
            outputSummary: error,
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

    getThread(threadId) {
      const thread = db
        .select({
          archivedAt: threadsTable.archivedAt,
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
          headMessageId: threadsTable.headMessageId,
          id: threadsTable.id,
          memoryRecallState: threadsTable.memoryRecallState,
          preview: threadsTable.preview,
          queuedFollowUpEnabledTools: threadsTable.queuedFollowUpEnabledTools,
          queuedFollowUpMessageId: threadsTable.queuedFollowUpMessageId,
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
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
          headMessageId: threadsTable.headMessageId,
          id: threadsTable.id,
          memoryRecallState: threadsTable.memoryRecallState,
          preview: threadsTable.preview,
          queuedFollowUpEnabledTools: threadsTable.queuedFollowUpEnabledTools,
          queuedFollowUpMessageId: threadsTable.queuedFollowUpMessageId,
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
            branchFromMessageId: thread.branchFromMessageId ?? null,
            branchFromThreadId: thread.branchFromThreadId ?? null,
            createdAt,
            headMessageId: thread.headMessageId ?? null,
            id: thread.id,
            memoryRecallState: serializeThreadMemoryRecallState(thread.memoryRecall),
            preview: thread.preview ?? null,
            queuedFollowUpEnabledTools: serializeEnabledTools(thread.queuedFollowUpEnabledTools),
            queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
            title: thread.title,
            updatedAt: thread.updatedAt,
            workspacePath: thread.workspacePath ?? null
          })
          .run()

        if (messages && messages.length > 0) {
          tx.insert(messagesTable)
            .values(
              messages.map((message) => ({
                ...message,
                textBlocks: serializeMessageTextBlocks(message.textBlocks),
                images: serializeMessageImages(message.images)
              }))
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

    archiveThread({ threadId, archivedAt, updatedAt }) {
      db.update(threadsTable)
        .set({
          archivedAt,
          updatedAt
        })
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

    deleteThread({ threadId }) {
      db.delete(threadsTable).where(eq(threadsTable.id, threadId)).run()
    },

    updateThread(thread) {
      db.update(threadsTable)
        .set({
          branchFromMessageId: thread.branchFromMessageId ?? null,
          branchFromThreadId: thread.branchFromThreadId ?? null,
          headMessageId: thread.headMessageId ?? null,
          memoryRecallState: serializeThreadMemoryRecallState(thread.memoryRecall),
          preview: thread.preview ?? null,
          queuedFollowUpEnabledTools: serializeEnabledTools(thread.queuedFollowUpEnabledTools),
          queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
          title: thread.title,
          updatedAt: thread.updatedAt,
          workspacePath: thread.workspacePath ?? null
        })
        .where(eq(threadsTable.id, thread.id))
        .run()
    },

    saveThreadMessage({ thread, updatedThread, message, replacedMessageId }) {
      db.transaction((tx) => {
        if (replacedMessageId) {
          tx.delete(messagesTable).where(eq(messagesTable.id, replacedMessageId)).run()
        }

        const { textBlocks, ...persistedMessage } = message
        tx.insert(messagesTable)
          .values({
            ...persistedMessage,
            textBlocks: serializeMessageTextBlocks(textBlocks),
            images: serializeMessageImages(message.images)
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
          const { textBlocks, ...persistedUserMessage } = userMessage
          tx.insert(messagesTable)
            .values({
              ...persistedUserMessage,
              textBlocks: serializeMessageTextBlocks(textBlocks),
              images: serializeMessageImages(userMessage.images)
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

    completeRun({ runId, updatedThread, assistantMessage }: CompleteRunInput) {
      db.transaction((tx) => {
        const { textBlocks, ...persistedAssistantMessage } = assistantMessage
        tx.insert(messagesTable)
          .values({
            ...persistedAssistantMessage,
            textBlocks: serializeMessageTextBlocks(textBlocks),
            images: serializeMessageImages(assistantMessage.images)
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
            queuedFollowUpMessageId: updatedThread.queuedFollowUpMessageId ?? null,
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
            status: 'completed'
          })
          .where(eq(runsTable.id, runId))
          .run()

        tx.update(toolCallsTable)
          .set({
            assistantMessageId: assistantMessage.id
          })
          .where(eq(toolCallsTable.runId, runId))
          .run()
      })
    },

    cancelRun({ runId, completedAt }) {
      db.update(runsTable)
        .set({
          completedAt,
          status: 'cancelled'
        })
        .where(eq(runsTable.id, runId))
        .run()
    },

    failRun({ runId, completedAt, error }) {
      db.update(runsTable)
        .set({
          completedAt,
          error,
          status: 'failed'
        })
        .where(eq(runsTable.id, runId))
        .run()
    },

    listThreadMessages(threadId) {
      return db
        .select({
          content: messagesTable.content,
          createdAt: messagesTable.createdAt,
          id: messagesTable.id,
          images: messagesTable.images,
          modelId: messagesTable.modelId,
          parentMessageId: messagesTable.parentMessageId,
          providerName: messagesTable.providerName,
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
      return db
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
          status: toolCallsTable.status,
          threadId: toolCallsTable.threadId,
          toolName: toolCallsTable.toolName
        })
        .from(toolCallsTable)
        .where(eq(toolCallsTable.threadId, threadId))
        .orderBy(asc(toolCallsTable.startedAt))
        .all()
        .map(toToolCallRecord)
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
          runId: toolCall.runId,
          startedAt: toolCall.startedAt,
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
            tx.delete(toolCallsTable)
              .where(
                inArray(
                  toolCallsTable.runId,
                  runsToDelete.map((run) => run.id)
                )
              )
              .run()
            tx.delete(runsTable)
              .where(
                inArray(
                  runsTable.id,
                  runsToDelete.map((run) => run.id)
                )
              )
              .run()
          }

          tx.delete(messagesTable).where(inArray(messagesTable.id, messageIds)).run()
        }

        tx.update(threadsTable)
          .set({
            headMessageId: thread.headMessageId ?? null,
            memoryRecallState: serializeThreadMemoryRecallState(thread.memoryRecall),
            preview: thread.preview ?? null,
            queuedFollowUpEnabledTools: serializeEnabledTools(thread.queuedFollowUpEnabledTools),
            queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
            title: thread.title,
            updatedAt: thread.updatedAt
          })
          .where(eq(threadsTable.id, thread.id))
          .run()
      })
    }
  }
}
