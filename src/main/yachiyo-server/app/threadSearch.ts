import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { and, asc, desc, eq, isNull, like } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { ToolCallRecord } from '../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoDataDir } from '../config/paths.ts'
import { isBundledSkillPath } from '../services/skills/skillDiscovery.ts'
import * as schema from '../storage/sqlite/schema.ts'
import { messagesTable, threadsTable, toolCallsTable } from '../storage/sqlite/schema.ts'

type SqliteDb = BetterSQLite3Database<typeof schema>

interface BetterSqlite3Statement {
  get(...params: unknown[]): Record<string, unknown>
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): void
}

interface BetterSqlite3Client {
  close(): void
  exec(sql: string): void
  pragma(sql: string): void
  prepare(sql: string): BetterSqlite3Statement
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

// Re-export from shared module for test compatibility
export { tokenizeQuery, toMatchExpression } from '../storage/ftsQuery.ts'

import {
  extractSnippet,
  toMatchExpression as toMatch,
  ftsMessageSearchSql,
  type FtsMessageRow
} from '../storage/ftsQuery.ts'

export function searchMessages(
  dbPath: string,
  query: string,
  limit: number,
  includePrivate = false
): MessageSearchHit[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  if (!existsSync(dbPath)) return []
  const matchExpr = toMatch(trimmed)
  if (matchExpr === '') return []

  const { BetterSqlite3 } = loadSqliteRuntime()
  const client = new BetterSqlite3(dbPath, { readonly: true })

  try {
    // FTS tables are created by the main server on startup. When the CLI
    // opens the DB readonly, the index should already exist. If it doesn't
    // (e.g. user has never launched the app), fall back to LIKE matching.
    const hasFts = (() => {
      try {
        client.prepare('SELECT COUNT(*) FROM messages_fts').get()
        return true
      } catch {
        return false
      }
    })()

    const privacyClause = includePrivate ? '' : 'AND threads.privacy_mode IS NULL'

    if (hasFts) {
      const rows = client
        .prepare(`${ftsMessageSearchSql(privacyClause)} LIMIT ?`)
        .all(matchExpr, limit) as FtsMessageRow[]

      return rows.map((row) => ({
        threadId: row.threadId,
        threadTitle: row.threadTitle,
        messageId: row.messageId,
        role: row.role as 'user' | 'assistant',
        date: row.createdAt.slice(0, 10),
        snippet: extractSnippet(row.content, trimmed)
      }))
    }

    // Fallback: LIKE-based search when FTS index is unavailable
    const { drizzle } = loadSqliteRuntime()
    const db = drizzle(client, { schema })
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
          like(messagesTable.content, `%${trimmed.replace(/[%_]/g, '')}%`),
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

export interface ThreadDumpToolCall {
  id: string
  runId: string | null
  toolName: ToolCallRecord['toolName']
  status: ToolCallRecord['status']
  inputSummary: string
  outputSummary: string | null
  error: string | null
  /**
   * Parsed JSON from the stored `details` column if it parses successfully,
   * otherwise the raw string, otherwise null. Per-tool shape; see protocol.ts
   * `ToolCallDetailsSnapshot` for the typed union.
   */
  details: unknown
  startedAt: string
  finishedAt: string | null
  stepIndex: number | null
}

export interface ThreadDump {
  threadId: string
  title: string
  preview: string | null
  updatedAt: string
  createdAt: string
  messages: ThreadDumpMessage[]
  toolCalls: ThreadDumpToolCall[]
}

/**
 * Safely parse a stored tool-call `details` payload. The DB column is a plain
 * text field that may hold JSON, a non-JSON string, or null. We prefer parsed
 * JSON so consumers don't have to parse it themselves, but fall back to the
 * raw string for legacy rows and null for empty ones.
 */
export function parseToolCallDetails(raw: string | null | undefined): unknown {
  if (raw == null || raw === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fallback-only enrichment for parsed `skillsRead` details payloads that
 * were written before `skillsReadTool` started storing the authoritative
 * `origin` field on every resolved skill. For any row that already has
 * `origin` pre-frozen, this is a pure pass-through — we never recompute
 * against the current `YACHIYO_HOME`, because a thread recorded under a
 * different home (isolated workspace, or the user moved their Yachiyo
 * home since the run) would get misclassified.
 *
 * For legacy rows with no `origin`, we compute a best-effort value from
 * `directoryPath` against the current home's core dir. This is
 * acknowledged-imperfect for historical data: if the current home differs
 * from the one the run was recorded under, the legacy fallback may be
 * wrong. All NEW rows bypass this entirely because the tool writes origin
 * at execution time.
 *
 * We only touch entries that look like resolved skill records (an object
 * with a string `directoryPath`); anything else is passed through
 * untouched.
 */
export function enrichSkillsReadDetails(parsed: unknown, yachiyoSkillsDir: string): unknown {
  if (!isRecord(parsed)) return parsed
  const skills = parsed['skills']
  if (!Array.isArray(skills)) return parsed
  const enrichedSkills = skills.map((entry) => {
    if (!isRecord(entry)) return entry
    // Stored origin is authoritative — frozen at write time. Pass through.
    if (typeof entry['origin'] === 'string') return entry
    // Legacy row: best-effort fallback using the current home's core dir.
    const directoryPath = entry['directoryPath']
    if (typeof directoryPath !== 'string') return entry
    const origin: 'bundled' | 'writable' = isBundledSkillPath(directoryPath, yachiyoSkillsDir)
      ? 'bundled'
      : 'writable'
    return { ...entry, origin }
  })
  return { ...parsed, skills: enrichedSkills }
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

    const toolCallRows = db
      .select({
        id: toolCallsTable.id,
        runId: toolCallsTable.runId,
        toolName: toolCallsTable.toolName,
        status: toolCallsTable.status,
        inputSummary: toolCallsTable.inputSummary,
        outputSummary: toolCallsTable.outputSummary,
        error: toolCallsTable.error,
        details: toolCallsTable.details,
        startedAt: toolCallsTable.startedAt,
        finishedAt: toolCallsTable.finishedAt,
        stepIndex: toolCallsTable.stepIndex
      })
      .from(toolCallsTable)
      .where(eq(toolCallsTable.threadId, threadId))
      .orderBy(asc(toolCallsTable.startedAt), asc(toolCallsTable.stepIndex))
      .all()

    // Resolve the Yachiyo home's skills directory once per dump so every
    // `skillsRead` tool call in this thread is classified against the same
    // authoritative installation root. A workspace-local `.yachiyo/skills/core/`
    // path will not match and will be emitted as writable, which is correct.
    const yachiyoSkillsDir = resolve(join(resolveYachiyoDataDir(), 'skills'))

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
      })),
      toolCalls: toolCallRows.map((row) => {
        const parsedDetails = parseToolCallDetails(row.details)
        const details =
          row.toolName === 'skillsRead'
            ? enrichSkillsReadDetails(parsedDetails, yachiyoSkillsDir)
            : parsedDetails
        return {
          id: row.id,
          runId: row.runId ?? null,
          toolName: row.toolName,
          status: row.status,
          inputSummary: row.inputSummary,
          outputSummary: row.outputSummary ?? null,
          error: row.error ?? null,
          details,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt ?? null,
          stepIndex: row.stepIndex ?? null
        }
      })
    }
  } finally {
    client.close()
  }
}
