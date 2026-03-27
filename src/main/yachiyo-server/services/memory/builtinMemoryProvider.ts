import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import type {
  MemoryTermDocument,
  MemoryTermEntry,
  MemoryTermTopic
} from '../../../../shared/yachiyo/protocol.ts'
import type { MemoryProvider, MemorySearchResult } from './memoryService.ts'

interface BuiltinMemoryProviderOptions {
  dbPath: string
}

interface BetterSqlite3Statement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number }
}

interface BetterSqlite3Client {
  close(): void
  exec(sql: string): void
  prepare(sql: string): BetterSqlite3Statement
  pragma(sql: string): void
}

type BetterSqlite3Constructor = new (path: string) => BetterSqlite3Client

type BetterSqlite3Module = {
  default?: BetterSqlite3Constructor
}

interface StoredBuiltinMemoryRow {
  id: string
  topic: string
  title: string
  content: string
  labels: string
  unit_type: string
  importance: number | null
  source_thread_id: string | null
  updated_at: string
  rank: number
}

const require = createRequire(import.meta.url)

function loadBetterSqlite3(): BetterSqlite3Constructor {
  const module = require('better-sqlite3') as BetterSqlite3Constructor | BetterSqlite3Module
  const runtime = typeof module === 'function' ? module : module.default

  if (!runtime) {
    throw new Error('Failed to load better-sqlite3 runtime')
  }

  return runtime
}

function withDatabase<T>(dbPath: string, run: (db: BetterSqlite3Client) => T): T {
  const BetterSqlite3 = loadBetterSqlite3()
  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = WAL')

  try {
    ensureBuiltinMemoryIndex(db)
    return run(db)
  } finally {
    db.close()
  }
}

function ensureBuiltinMemoryIndex(db: BetterSqlite3Client): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS builtin_memories_fts USING fts5(
      title,
      content,
      topic,
      labels,
      content='builtin_memories',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS builtin_memories_ai AFTER INSERT ON builtin_memories BEGIN
      INSERT INTO builtin_memories_fts(rowid, title, content, topic, labels)
      VALUES (new.rowid, new.title, new.content, new.topic, new.labels);
    END;

    CREATE TRIGGER IF NOT EXISTS builtin_memories_ad AFTER DELETE ON builtin_memories BEGIN
      INSERT INTO builtin_memories_fts(builtin_memories_fts, rowid, title, content, topic, labels)
      VALUES ('delete', old.rowid, old.title, old.content, old.topic, old.labels);
    END;

    CREATE TRIGGER IF NOT EXISTS builtin_memories_au AFTER UPDATE ON builtin_memories BEGIN
      INSERT INTO builtin_memories_fts(builtin_memories_fts, rowid, title, content, topic, labels)
      VALUES ('delete', old.rowid, old.title, old.content, old.topic, old.labels);
      INSERT INTO builtin_memories_fts(rowid, title, content, topic, labels)
      VALUES (new.rowid, new.title, new.content, new.topic, new.labels);
    END;
  `)

  const indexedRowCount = db
    .prepare('SELECT COUNT(*) AS count FROM builtin_memories_fts')
    .get() as { count?: number }
  const storedRowCount = db.prepare('SELECT COUNT(*) AS count FROM builtin_memories').get() as {
    count?: number
  }

  if ((indexedRowCount.count ?? 0) === 0 && (storedRowCount.count ?? 0) > 0) {
    db.prepare("INSERT INTO builtin_memories_fts(builtin_memories_fts) VALUES ('rebuild')").run()
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function tokenizeQuery(query: string): string[] {
  return (
    normalizeWhitespace(query)
      .toLowerCase()
      .match(/[a-z0-9]+|[\p{Script=Han}]{1,}/gu)
      ?.filter(Boolean) ?? []
  )
}

function toMatchExpression(query: string): string {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) {
    return ''
  }

  return tokens.map((token) => `"${token.replace(/"/gu, '""')}"`).join(' OR ')
}

function parseLabels(value: string): string[] | undefined {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) {
    return undefined
  }

  const labels = parsed.filter((label): label is string => typeof label === 'string' && !!label)
  return labels.length > 0 ? labels : undefined
}

function buildLabels(topic: string): string[] {
  return [`topic:${topic}`]
}

function toStoredLabels(topic: string): string {
  return JSON.stringify(buildLabels(topic))
}

function normalizeRank(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 0
  }

  return 1 / (1 + Math.exp(rank))
}

function toSearchResult(row: StoredBuiltinMemoryRow): MemorySearchResult {
  const labels = parseLabels(row.labels)

  return {
    id: row.id,
    title: row.title,
    content: row.content,
    score: normalizeRank(row.rank),
    ...(row.source_thread_id ? { sourceThreadId: row.source_thread_id } : {}),
    ...(labels ? { labels } : {}),
    ...(row.importance !== null ? { importance: row.importance } : {}),
    unitType: row.unit_type as MemorySearchResult['unitType']
  }
}

function parseTopicLabel(label: string | undefined): string | null {
  if (!label?.startsWith('topic:')) {
    return null
  }

  const topic = label.slice('topic:'.length).trim()
  return topic || null
}

export function createBuiltinMemoryProvider(options: BuiltinMemoryProviderOptions): MemoryProvider {
  return {
    async createMemories(input): Promise<{ savedCount: number }> {
      return withDatabase(options.dbPath, (db) => {
        const statement = db.prepare(`
          INSERT INTO builtin_memories (
            id,
            topic,
            title,
            content,
            labels,
            unit_type,
            importance,
            source_thread_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const now = new Date().toISOString()

        for (const item of input.items) {
          statement.run(
            randomUUID(),
            item.topic,
            item.title,
            item.content,
            toStoredLabels(item.topic),
            item.unitType,
            item.importance ?? null,
            null,
            now,
            now
          )
        }

        return { savedCount: input.items.length }
      })
    },

    async searchMemories(input): Promise<MemorySearchResult[]> {
      const matchExpression = toMatchExpression(input.query)
      if (!matchExpression) {
        return []
      }

      return withDatabase(options.dbPath, (db) => {
        const topic = parseTopicLabel(input.label)
        const statement = topic
          ? db.prepare(`
              SELECT
                builtin_memories.id,
                builtin_memories.topic,
                builtin_memories.title,
                builtin_memories.content,
                builtin_memories.labels,
                builtin_memories.unit_type,
                builtin_memories.importance,
                builtin_memories.source_thread_id,
                bm25(builtin_memories_fts, 3.5, 1.5, 1.2, 0.8) AS rank
              FROM builtin_memories_fts
              JOIN builtin_memories ON builtin_memories.rowid = builtin_memories_fts.rowid
              WHERE builtin_memories_fts MATCH ? AND builtin_memories.topic = ?
              ORDER BY rank ASC, builtin_memories.updated_at DESC
              LIMIT ?
            `)
          : db.prepare(`
              SELECT
                builtin_memories.id,
                builtin_memories.topic,
                builtin_memories.title,
                builtin_memories.content,
                builtin_memories.labels,
                builtin_memories.unit_type,
                builtin_memories.importance,
                builtin_memories.source_thread_id,
                bm25(builtin_memories_fts, 3.5, 1.5, 1.2, 0.8) AS rank
              FROM builtin_memories_fts
              JOIN builtin_memories ON builtin_memories.rowid = builtin_memories_fts.rowid
              WHERE builtin_memories_fts MATCH ?
              ORDER BY rank ASC, builtin_memories.updated_at DESC
              LIMIT ?
            `)

        const rows = (
          topic
            ? statement.all(matchExpression, topic, input.limit)
            : statement.all(matchExpression, input.limit)
        ) as StoredBuiltinMemoryRow[]

        return rows.map(toSearchResult)
      })
    },

    async updateMemory(input): Promise<void> {
      withDatabase(options.dbPath, (db) => {
        const updatedAt = new Date().toISOString()
        const result = db
          .prepare(
            `
            UPDATE builtin_memories
            SET topic = ?, title = ?, content = ?, labels = ?, unit_type = ?, importance = ?, updated_at = ?
            WHERE id = ?
          `
          )
          .run(
            input.item.topic,
            input.item.title,
            input.item.content,
            toStoredLabels(input.item.topic),
            input.item.unitType,
            input.item.importance ?? null,
            updatedAt,
            input.id
          )

        if (result.changes === 0) {
          throw new Error(`Unknown builtin memory: ${input.id}`)
        }
      })
    }
  }
}

function toTermEntry(row: StoredBuiltinMemoryRow): MemoryTermEntry {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    unitType: row.unit_type as MemoryTermEntry['unitType'],
    ...(row.importance !== null ? { importance: row.importance } : {}),
    updatedAt: row.updated_at
  }
}

function toTopic(topic: string, rows: StoredBuiltinMemoryRow[]): MemoryTermTopic {
  const entries = rows
    .slice()
    .sort((left, right) => left.title.localeCompare(right.title))
    .map(toTermEntry)

  return {
    topic,
    entryCount: entries.length,
    entries
  }
}

export function readBuiltinMemoryTermDocument(
  options: BuiltinMemoryProviderOptions
): MemoryTermDocument {
  return withDatabase(options.dbPath, (db) => {
    const rows = db
      .prepare(
        `
        SELECT
          id,
          topic,
          title,
          content,
          labels,
          unit_type,
          importance,
          source_thread_id,
          updated_at,
          0 AS rank
        FROM builtin_memories
        ORDER BY topic ASC, title ASC
      `
      )
      .all() as StoredBuiltinMemoryRow[]

    const grouped = new Map<string, StoredBuiltinMemoryRow[]>()
    for (const row of rows) {
      const current = grouped.get(row.topic) ?? []
      current.push(row)
      grouped.set(row.topic, current)
    }

    const topics = [...grouped.entries()].map(([topic, topicRows]) => toTopic(topic, topicRows))

    return {
      provider: 'builtin-memory',
      topicCount: topics.length,
      memoryCount: rows.length,
      topics
    }
  })
}
