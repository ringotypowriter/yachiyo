import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import { and, asc, desc, eq, isNull, like } from 'drizzle-orm'
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

export function searchMessages(dbPath: string, query: string, limit: number): MessageSearchHit[] {
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
      .where(and(isNull(threadsTable.archivedAt), like(messagesTable.content, pattern)))
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
