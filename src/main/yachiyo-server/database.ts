import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'

import type { MessageRecord } from '../../shared/yachiyo/protocol'
import * as schema from './schema.ts'
import { messagesTable, runsTable, threadsTable } from './schema.ts'
import {
  groupMessagesByThread,
  toThreadRecord,
  type CompleteRunInput,
  type StartRunInput,
  type YachiyoStorage
} from './storage.ts'

const MIGRATIONS_DIR = fileURLToPath(new URL('./drizzle', import.meta.url))
const require = createRequire(import.meta.url)

function loadSqliteRuntime() {
  const BetterSqlite3Module = require('better-sqlite3') as
    | {
        default?: new (path: string) => {
          close(): void
          pragma(sql: string): void
        }
      }
    | (new (path: string) => {
        close(): void
        pragma(sql: string): void
      })
  const drizzleModule = require('drizzle-orm/better-sqlite3') as {
    drizzle: (client: unknown, options: { schema: typeof import('./schema.ts') }) => {
      select: (...args: unknown[]) => any
      insert: (...args: unknown[]) => any
      update: (...args: unknown[]) => any
      transaction: <T>(callback: (tx: any) => T) => T
    }
  }
  const migratorModule = require('drizzle-orm/better-sqlite3/migrator') as {
    migrate: (db: unknown, options: { migrationsFolder: string }) => void
  }
  const BetterSqlite3 = ((BetterSqlite3Module as { default?: unknown }).default ??
    BetterSqlite3Module) as new (path: string) => {
    close(): void
    pragma(sql: string): void
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
                role: messagesTable.role,
                status: messagesTable.status,
                threadId: messagesTable.threadId
              })
              .from(messagesTable)
              .where(inArray(messagesTable.threadId, threadIds))
              .orderBy(asc(messagesTable.createdAt))
              .all()

      return {
        threads,
        messagesByThread: groupMessagesByThread(messages)
      }
    },

    getThread(threadId) {
      const thread = db
        .select({
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

    createThread({ thread, createdAt }) {
      db.insert(threadsTable)
        .values({
          archivedAt: null,
          createdAt,
          id: thread.id,
          preview: thread.preview ?? null,
          title: thread.title,
          updatedAt: thread.updatedAt
        })
        .run()
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

    startRun({ runId, thread, updatedThread, userMessage, createdAt }: StartRunInput) {
      db.transaction((tx) => {
        tx.insert(messagesTable).values(userMessage).run()

        tx.update(threadsTable)
          .set({
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
            status: 'running',
            threadId: thread.id
          })
          .run()
      })
    },

    completeRun({ runId, threadId, assistantMessage, preview, updatedAt }: CompleteRunInput) {
      db.transaction((tx) => {
        tx.insert(messagesTable).values(assistantMessage).run()

        tx.update(threadsTable)
          .set({
            preview,
            updatedAt
          })
          .where(eq(threadsTable.id, threadId))
          .run()

        tx.update(runsTable)
          .set({
            completedAt: updatedAt,
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

    listThreadHistory(threadId) {
      return db
        .select({
          content: messagesTable.content,
          role: messagesTable.role
        })
        .from(messagesTable)
        .where(eq(messagesTable.threadId, threadId))
        .orderBy(asc(messagesTable.createdAt))
        .all() as Array<Pick<MessageRecord, 'content' | 'role'>>
    }
  }
}
