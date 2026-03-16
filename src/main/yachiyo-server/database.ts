import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema.ts'
import { messagesTable, runsTable, threadsTable } from './schema.ts'
import {
  groupMessagesByThread,
  serializeMessageImages,
  toMessageRecord,
  toThreadRecord,
  type CompleteRunInput,
  type CreateThreadInput,
  type DeleteMessagesInput,
  type StartRunInput,
  type YachiyoStorage
} from './storage.ts'

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
      const threads = db
        .select({
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
          headMessageId: threadsTable.headMessageId,
          id: threadsTable.id,
          preview: threadsTable.preview,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt
        })
        .from(threadsTable)
        .where(isNull(threadsTable.archivedAt))
        .orderBy(desc(threadsTable.updatedAt))
        .all()
        .map(toThreadRecord)

      const threadIds = threads.map((thread) => thread.id)
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
                threadId: messagesTable.threadId
              })
              .from(messagesTable)
              .where(inArray(messagesTable.threadId, threadIds))
              .orderBy(asc(messagesTable.createdAt))
              .all()
              .map(toMessageRecord)

      return {
        threads,
        messagesByThread: groupMessagesByThread(messages)
      }
    },

    getThread(threadId) {
      const thread = db
        .select({
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
          headMessageId: threadsTable.headMessageId,
          id: threadsTable.id,
          preview: threadsTable.preview,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt
        })
        .from(threadsTable)
        .where(and(eq(threadsTable.id, threadId), isNull(threadsTable.archivedAt)))
        .get()

      return thread ? toThreadRecord(thread) : undefined
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
            preview: thread.preview ?? null,
            title: thread.title,
            updatedAt: thread.updatedAt
          })
          .run()

        if (messages && messages.length > 0) {
          tx.insert(messagesTable)
            .values(
              messages.map((message) => ({
                ...message,
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

    updateThread(thread) {
      db.update(threadsTable)
        .set({
          branchFromMessageId: thread.branchFromMessageId ?? null,
          branchFromThreadId: thread.branchFromThreadId ?? null,
          headMessageId: thread.headMessageId ?? null,
          preview: thread.preview ?? null,
          title: thread.title,
          updatedAt: thread.updatedAt
        })
        .where(eq(threadsTable.id, thread.id))
        .run()
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
          tx.insert(messagesTable)
            .values({
              ...userMessage,
              images: serializeMessageImages(userMessage.images)
            })
            .run()
        }

        tx.update(threadsTable)
          .set({
            headMessageId: updatedThread.headMessageId ?? null,
            preview: updatedThread.preview ?? null,
            title: updatedThread.title,
            updatedAt: updatedThread.updatedAt
          })
          .where(eq(threadsTable.id, thread.id))
          .run()

        tx.insert(runsTable)
          .values({
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
        tx.insert(messagesTable)
          .values({
            ...assistantMessage,
            images: serializeMessageImages(assistantMessage.images)
          })
          .run()

        tx.update(threadsTable)
          .set({
            headMessageId: updatedThread.headMessageId ?? null,
            preview: updatedThread.preview ?? null,
            title: updatedThread.title,
            updatedAt: updatedThread.updatedAt
          })
          .where(eq(threadsTable.id, updatedThread.id))
          .run()

        tx.update(runsTable)
          .set({
            completedAt: updatedThread.updatedAt,
            status: 'completed'
          })
          .where(eq(runsTable.id, runId))
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
          threadId: messagesTable.threadId
        })
        .from(messagesTable)
        .where(eq(messagesTable.threadId, threadId))
        .orderBy(asc(messagesTable.createdAt))
        .all()
        .map(toMessageRecord)
    },

    deleteMessages({ thread, messageIds }: DeleteMessagesInput) {
      db.transaction((tx) => {
        if (messageIds.length > 0) {
          tx.delete(messagesTable).where(inArray(messagesTable.id, messageIds)).run()
        }

        tx.update(threadsTable)
          .set({
            headMessageId: thread.headMessageId ?? null,
            preview: thread.preview ?? null,
            title: thread.title,
            updatedAt: thread.updatedAt
          })
          .where(eq(threadsTable.id, thread.id))
          .run()
      })
    }
  }
}
