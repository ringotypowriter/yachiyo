import assert from 'node:assert/strict'
import test from 'node:test'

import { FTS_TOKENIZE } from '../ftsQuery.ts'
import { ensureThreadSearchIndex } from './threadSearchIndex.ts'

interface FakeClient {
  execSql: string[]
  client: never
}

function makeFakeClient(
  input: {
    existingFtsTableSql?: string[]
    rowCounts?: Record<string, number>
  } = {}
): FakeClient {
  const execSql: string[] = []
  const client = {
    exec(sql: string): void {
      execSql.push(sql)
    },
    prepare(sql: string) {
      return {
        get: () => {
          const table = sql.match(/FROM (\S+)/u)?.[1] ?? ''
          return { count: input.rowCounts?.[table] ?? 0 }
        },
        run: () => {},
        all: () =>
          sql.includes('sqlite_master')
            ? (input.existingFtsTableSql ?? []).map((entry) => ({ sql: entry }))
            : []
      }
    }
  } as never
  return { execSql, client }
}

test('thread search FTS update triggers only run when indexed columns change', () => {
  const fake = makeFakeClient()

  ensureThreadSearchIndex(fake.client)

  const ddl = fake.execSql.join('\n')
  assert.match(ddl, /DROP TRIGGER IF EXISTS messages_fts_au/u)
  assert.match(
    ddl,
    /CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages/u
  )
  assert.doesNotMatch(ddl, /messages_fts_au AFTER UPDATE ON messages/u)
  assert.match(
    ddl,
    /CREATE TRIGGER IF NOT EXISTS threads_fts_au AFTER UPDATE OF title, preview ON threads/u
  )
  assert.doesNotMatch(ddl, /threads_fts_au AFTER UPDATE ON threads/u)
})

test('thread search FTS tables use the diacritics-folding trigram tokenizer', () => {
  const fake = makeFakeClient()

  ensureThreadSearchIndex(fake.client)

  const ddl = fake.execSql.join('\n')
  const creates = ddl.match(/CREATE VIRTUAL TABLE[^;]+/gu) ?? []
  assert.equal(creates.length, 2)
  for (const create of creates) {
    assert.ok(create.includes(FTS_TOKENIZE), create)
  }
  assert.doesNotMatch(ddl, /unicode61/u)
})

test('stale-tokenizer FTS tables are dropped and recreated', () => {
  const fake = makeFakeClient({
    existingFtsTableSql: [
      "CREATE VIRTUAL TABLE threads_fts USING fts5(title, preview, content='threads', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')",
      "CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')"
    ]
  })

  ensureThreadSearchIndex(fake.client)

  const ddl = fake.execSql.join('\n')
  assert.match(ddl, /DROP TABLE IF EXISTS threads_fts/u)
  assert.match(ddl, /DROP TABLE IF EXISTS messages_fts/u)
})

test('existing current-tokenizer FTS tables are kept as-is', () => {
  const fake = makeFakeClient({
    existingFtsTableSql: [
      `CREATE VIRTUAL TABLE threads_fts USING fts5(title, preview, content='threads', content_rowid='rowid', ${FTS_TOKENIZE})`,
      `CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid', ${FTS_TOKENIZE})`
    ]
  })

  ensureThreadSearchIndex(fake.client)

  const ddl = fake.execSql.join('\n')
  assert.doesNotMatch(ddl, /DROP TABLE/u)
})

test('a pending full rebuild goes through the scheduler instead of blocking', () => {
  // Empty index (_docsize = 0) behind a populated messages table.
  const fake = makeFakeClient({ rowCounts: { messages: 5, threads: 2 } })
  const scheduled: Array<() => void> = []

  ensureThreadSearchIndex(fake.client, {
    scheduleRebuild: (rebuild) => {
      scheduled.push(rebuild)
    }
  })

  assert.equal(scheduled.length, 1)
})

test('no scheduler call when the index is already populated', () => {
  const fake = makeFakeClient({
    rowCounts: {
      messages: 5,
      threads: 2,
      messages_fts_docsize: 5,
      threads_fts_docsize: 2
    }
  })
  const scheduled: Array<() => void> = []

  ensureThreadSearchIndex(fake.client, {
    scheduleRebuild: (rebuild) => {
      scheduled.push(rebuild)
    }
  })

  assert.equal(scheduled.length, 0)
})
