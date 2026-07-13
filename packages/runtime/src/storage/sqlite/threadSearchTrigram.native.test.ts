import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { MessageRecord, ThreadRecord } from '@yachiyo/shared/protocol'
import { createSqliteYachiyoStorage } from './database.ts'

const require = createRequire(import.meta.url)
const BetterSqlite3Module = require('better-sqlite3') as { default?: unknown }
const SqliteDatabase = (BetterSqlite3Module.default ?? BetterSqlite3Module) as new (
  path: string
) => {
  close(): void
  exec(sql: string): void
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>
    get(...params: unknown[]): Record<string, unknown> | undefined
    run(...params: unknown[]): void
  }
}

const NOW = '2024-01-01T00:00:00.000Z'

function makeThread(overrides: Partial<ThreadRecord> & { id: string }): ThreadRecord {
  return { title: 'Untitled', updatedAt: NOW, ...overrides }
}

function makeMessage(
  overrides: Partial<MessageRecord> & { id: string; threadId: string }
): MessageRecord {
  return { role: 'user', content: '', status: 'completed', createdAt: NOW, ...overrides }
}

function seedThreads(storage: ReturnType<typeof createSqliteYachiyoStorage>): void {
  storage.createThread({
    thread: makeThread({ id: 'thread-zh', title: '数据库迁移讨论' }),
    createdAt: NOW,
    messages: [
      makeMessage({
        id: 'msg-zh-1',
        threadId: 'thread-zh',
        content: '我们在评审数据库迁移的方案，顺便聊聊搜索功能'
      })
    ]
  })
  storage.createThread({
    thread: makeThread({ id: 'thread-en', title: 'Weekly sync notes' }),
    createdAt: NOW,
    messages: [
      makeMessage({
        id: 'msg-en-1',
        threadId: 'thread-en',
        content: 'Fixing the workflow BUG in search'
      })
    ]
  })
  storage.createThread({
    thread: makeThread({ id: 'thread-mixed', title: 'Ops notes' }),
    createdAt: NOW,
    messages: [
      makeMessage({ id: 'msg-db', threadId: 'thread-mixed', content: 'the db is acting up again' }),
      makeMessage({ id: 'msg-cafe', threadId: 'thread-mixed', content: 'café menu review' })
    ]
  })
}

test('trigram FTS matches CJK substrings end to end', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-trigram-native-'))
  try {
    const storage = createSqliteYachiyoStorage(join(root, 'db.sqlite'))
    try {
      seedThreads(storage)

      // 4-char CJK phrase — trigram MATCH path, content substring.
      const byPhrase = storage.searchThreadsAndMessagesFts({ query: '数据库迁移' })
      assert.ok(byPhrase.find((r) => r.threadId === 'thread-zh'))
      assert.equal(byPhrase.find((r) => r.threadId === 'thread-zh')?.titleMatched, true)

      // 2-char CJK word — below the trigram minimum, LIKE fallback path.
      const byShort = storage.searchThreadsAndMessagesFts({ query: '搜索' })
      assert.ok(byShort.find((r) => r.threadId === 'thread-zh'))

      // ASCII stays case-insensitive on the MATCH path.
      const byCase = storage.searchThreadsAndMessagesFts({ query: 'WORKFLOW' })
      assert.ok(byCase.find((r) => r.threadId === 'thread-en'))

      // Sidebar search (active scope) rides the ranked FTS path.
      const ui = storage.searchThreadsAndMessages({ query: '数据库迁移' })
      const uiHit = ui.find((r) => r.threadId === 'thread-zh')
      assert.ok(uiHit)
      assert.equal(uiHit.titleMatched, true)
      assert.ok(uiHit.messageMatches.some((m) => m.messageId === 'msg-zh-1'))

      // Short queries keep the sidebar LIKE path working too.
      const uiShort = storage.searchThreadsAndMessages({ query: '搜索' })
      assert.ok(uiShort.find((r) => r.threadId === 'thread-zh'))

      // Mixed query: the short token 'db' is LIKE-supplemented, not dropped.
      const mixed = storage.searchThreadsAndMessagesFts({ query: 'db migration' })
      assert.ok(mixed.find((r) => r.threadId === 'thread-mixed'))

      // Diacritic folding: 'cafe' finds 'café'.
      const cafe = storage.searchThreadsAndMessagesFts({ query: 'cafe' })
      assert.ok(cafe.find((r) => r.threadId === 'thread-mixed'))

      // Sidebar multi-word search keeps contiguous-phrase semantics:
      // the phrase matches, the shuffled word order does not.
      const uiPhrase = storage.searchThreadsAndMessages({ query: 'workflow bug' })
      assert.ok(uiPhrase.find((r) => r.threadId === 'thread-en'))
      const uiShuffled = storage.searchThreadsAndMessages({ query: 'bug workflow' })
      assert.ok(!uiShuffled.find((r) => r.threadId === 'thread-en'))

      // Archived scope still served by the LIKE scan.
      storage.archiveThread({ threadId: 'thread-en', archivedAt: NOW, updatedAt: NOW })
      const archived = storage.searchThreadsAndMessages({ query: 'workflow', scope: 'archived' })
      assert.ok(archived.find((r) => r.threadId === 'thread-en'))
      const active = storage.searchThreadsAndMessages({ query: 'workflow' })
      assert.ok(!active.find((r) => r.threadId === 'thread-en'))
    } finally {
      storage.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy unicode61 FTS tables are migrated to trigram on open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-trigram-native-'))
  const dbPath = join(root, 'db.sqlite')
  try {
    const storage = createSqliteYachiyoStorage(dbPath)
    seedThreads(storage)
    storage.close()

    // Rewind the index to the pre-trigram tokenizer, as an old database
    // would have it.
    const raw = new SqliteDatabase(dbPath)
    raw.exec(`
      DROP TABLE IF EXISTS threads_fts;
      DROP TABLE IF EXISTS messages_fts;
      CREATE VIRTUAL TABLE threads_fts USING fts5(
        title, preview, content='threads', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content, content='messages', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      INSERT INTO threads_fts(threads_fts) VALUES ('rebuild');
      INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
    `)
    raw.close()

    const reopened = createSqliteYachiyoStorage(dbPath)
    try {
      // Pre-existing CJK content becomes searchable after the automatic
      // drop-and-rebuild.
      const results = reopened.searchThreadsAndMessagesFts({ query: '数据库迁移' })
      assert.ok(results.find((r) => r.threadId === 'thread-zh'))
    } finally {
      reopened.close()
    }

    const check = new SqliteDatabase(dbPath)
    const ftsSql = check
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('threads_fts', 'messages_fts')`
      )
      .all() as Array<{ sql: string }>
    check.close()
    assert.equal(ftsSql.length, 2)
    for (const row of ftsSql) {
      assert.ok(row.sql.includes("tokenize='trigram remove_diacritics 1'"), row.sql)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
