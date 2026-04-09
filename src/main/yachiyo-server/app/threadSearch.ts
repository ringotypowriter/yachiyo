import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import { and, asc, desc, eq, isNull, like } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from '../storage/sqlite/schema.ts'
import { messagesTable, threadsTable } from '../storage/sqlite/schema.ts'

type SqliteDb = BetterSQLite3Database<typeof schema>

interface BetterSqlite3Client {
  close(): void
  pragma(sql: string): void
}

type BetterSqlite3Options = { readonly?: boolean }
type BetterSqlite3Constructor = new (
  path: string,
  options?: BetterSqlite3Options
) => BetterSqlite3Client
type BetterSqlite3Module = { default?: BetterSqlite3Constructor }

interface SqliteRuntime {
  BetterSqlite3: BetterSqlite3Constructor
  drizzle: (client: BetterSqlite3Client, options: { schema: typeof schema }) => SqliteDb
}

const _require = createRequire(import.meta.url)

function loadSqliteRuntime(): SqliteRuntime {
  const mod = _require('better-sqlite3') as BetterSqlite3Constructor | BetterSqlite3Module
  const drizzleModule = _require('drizzle-orm/better-sqlite3') as Pick<SqliteRuntime, 'drizzle'>
  const BetterSqlite3 = typeof mod === 'function' ? mod : mod.default
  if (!BetterSqlite3) throw new Error('Failed to load better-sqlite3 runtime')
  return { BetterSqlite3, drizzle: drizzleModule.drizzle }
}

export interface MessageSearchHit {
  threadId: string
  threadTitle: string
  messageId: string
  role: 'user' | 'assistant'
  date: string
  snippet: string
}

function toSearchPattern(query: string): string {
  return `%${query.replace(/[%_]/g, '')}%`
}

function extractSnippet(content: string, query: string, maxLength = 100): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) {
    return content.length > maxLength ? `${content.slice(0, maxLength)}…` : content
  }
  const start = Math.max(0, idx - 8)
  const end = Math.min(content.length, start + maxLength)
  const snippet = content.slice(start, end)
  return `${start > 0 ? '…' : ''}${snippet}${end < content.length ? '…' : ''}`
}

export function searchMessages(
  dbPath: string,
  query: string,
  limit: number,
  includePrivate = false
): MessageSearchHit[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  if (!existsSync(dbPath)) return []

  const { BetterSqlite3, drizzle } = loadSqliteRuntime()
  const client = new BetterSqlite3(dbPath, { readonly: true })
  const db = drizzle(client, { schema })

  try {
    const pattern = toSearchPattern(trimmed)
    const rows = db
      .select({
        threadId: threadsTable.id,
        threadTitle: threadsTable.title,
        messageId: messagesTable.id,
        role: messagesTable.role,
        createdAt: messagesTable.createdAt,
        content: messagesTable.content
      })
      .from(messagesTable)
      .innerJoin(threadsTable, eq(messagesTable.threadId, threadsTable.id))
      .where(
        and(
          isNull(threadsTable.archivedAt),
          like(messagesTable.content, pattern),
          ...(includePrivate ? [] : [isNull(threadsTable.privacyMode)])
        )
      )
      .orderBy(desc(threadsTable.updatedAt), asc(messagesTable.createdAt))
      .limit(limit)
      .all()

    return rows.map((row) => ({
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      messageId: row.messageId,
      role: row.role,
      date: row.createdAt.slice(0, 10),
      snippet: extractSnippet(row.content, trimmed)
    }))
  } finally {
    client.close()
  }
}

export interface ThreadSummary {
  threadId: string
  title: string
  preview: string | null
  firstUserQuery: string | null
  messageCount: number
  selfReviewedAt: string | null
  updatedAt: string
  createdAt: string
}

function truncate(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max)}…`
}

export function listRecentThreads(
  dbPath: string,
  limit: number,
  includePrivate = false
): ThreadSummary[] {
  if (!existsSync(dbPath)) return []

  const { BetterSqlite3, drizzle } = loadSqliteRuntime()
  const client = new BetterSqlite3(dbPath, { readonly: true })
  const db = drizzle(client, { schema })

  try {
    const threads = db
      .select({
        id: threadsTable.id,
        title: threadsTable.title,
        preview: threadsTable.preview,
        selfReviewedAt: threadsTable.selfReviewedAt,
        updatedAt: threadsTable.updatedAt,
        createdAt: threadsTable.createdAt
      })
      .from(threadsTable)
      .where(
        and(
          isNull(threadsTable.archivedAt),
          ...(includePrivate ? [] : [isNull(threadsTable.privacyMode)])
        )
      )
      .orderBy(desc(threadsTable.updatedAt))
      .limit(limit)
      .all()

    return threads.map((t) => {
      const firstUser = db
        .select({ content: messagesTable.content })
        .from(messagesTable)
        .where(and(eq(messagesTable.threadId, t.id), eq(messagesTable.role, 'user')))
        .orderBy(asc(messagesTable.createdAt))
        .limit(1)
        .get()

      const countRow = db
        .select({ n: sql<number>`count(*)` })
        .from(messagesTable)
        .where(eq(messagesTable.threadId, t.id))
        .get()

      return {
        threadId: t.id,
        title: t.title,
        preview: t.preview ? truncate(t.preview) : null,
        firstUserQuery: firstUser ? truncate(firstUser.content) : null,
        messageCount: countRow?.n ?? 0,
        selfReviewedAt: t.selfReviewedAt,
        updatedAt: t.updatedAt,
        createdAt: t.createdAt
      }
    })
  } finally {
    client.close()
  }
}

export interface ThreadDumpMessage {
  messageId: string
  role: 'user' | 'assistant' | string
  createdAt: string
  content: string
}

export interface ThreadDump {
  threadId: string
  title: string
  preview: string | null
  updatedAt: string
  createdAt: string
  messages: ThreadDumpMessage[]
}

export function dumpThread(
  dbPath: string,
  threadId: string,
  includePrivate = false
): ThreadDump | null {
  if (!existsSync(dbPath)) return null

  const { BetterSqlite3, drizzle } = loadSqliteRuntime()
  const client = new BetterSqlite3(dbPath)
  const db = drizzle(client, { schema })

  try {
    const thread = db
      .select({
        id: threadsTable.id,
        title: threadsTable.title,
        preview: threadsTable.preview,
        privacyMode: threadsTable.privacyMode,
        updatedAt: threadsTable.updatedAt,
        createdAt: threadsTable.createdAt
      })
      .from(threadsTable)
      .where(eq(threadsTable.id, threadId))
      .get()

    if (!thread) return null
    if (!includePrivate && thread.privacyMode === '1') return null

    db.update(threadsTable)
      .set({ selfReviewedAt: new Date().toISOString() })
      .where(eq(threadsTable.id, threadId))
      .run()

    const messages = db
      .select({
        id: messagesTable.id,
        role: messagesTable.role,
        createdAt: messagesTable.createdAt,
        content: messagesTable.content
      })
      .from(messagesTable)
      .where(eq(messagesTable.threadId, threadId))
      .orderBy(asc(messagesTable.createdAt))
      .all()

    return {
      threadId: thread.id,
      title: thread.title,
      preview: thread.preview,
      updatedAt: thread.updatedAt,
      createdAt: thread.createdAt,
      messages: messages.map((m) => ({
        messageId: m.id,
        role: m.role,
        createdAt: m.createdAt,
        content: m.content
      }))
    }
  } finally {
    client.close()
  }
}
