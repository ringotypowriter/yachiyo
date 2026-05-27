import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import type { QuerySourceToolInput } from './querySourceTool.ts'
import { createSqliteSourceQueryExecutor } from './querySourceSqliteExecutor.ts'

const LOCAL_SOURCE_TABLES: QuerySourceToolInput['from'][] = [
  'source_events',
  'thread_folders',
  'threads',
  'thread_spans',
  'thread_messages',
  'activity_records'
]

test('sqlite querySource executor sends every local source table to the worker', async () => {
  const executor = createSqliteSourceQueryExecutor({
    dbPath: join(tmpdir(), 'missing-yachiyo-source-query.sqlite')
  })

  for (const from of LOCAL_SOURCE_TABLES) {
    const status = await executor.query({ from, view: 'index' }, new AbortController().signal).then(
      () => 'resolved',
      () => 'rejected'
    )

    assert.equal(status, 'rejected', `${from} should be handled by the sqlite worker`)
  }
})

test('sqlite querySource worker parses before opening the database', async () => {
  const executor = createSqliteSourceQueryExecutor({
    dbPath: join(tmpdir(), 'missing-yachiyo-source-query.sqlite')
  })

  await assert.rejects(
    () => executor.query({ from: 'source_events', view: 'index' }, new AbortController().signal),
    (error) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, /Invalid or unexpected token/u)
      return true
    }
  )
})

test('sqlite querySource worker resolves better-sqlite3 from the app module path', async () => {
  const originalCwd = process.cwd()
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-worker-cwd-'))

  try {
    process.chdir(root)

    const executor = createSqliteSourceQueryExecutor({
      dbPath: join(root, 'missing-yachiyo-source-query.sqlite')
    })

    await assert.rejects(
      () => executor.query({ from: 'source_events', view: 'index' }, new AbortController().signal),
      (error) => {
        assert.ok(error instanceof Error)
        assert.doesNotMatch(error.message, /Cannot find module 'better-sqlite3'/u)
        assert.doesNotMatch(error.message, /\[worker eval\]/u)
        return true
      }
    )
  } finally {
    process.chdir(originalCwd)
    await rm(root, { recursive: true, force: true })
  }
})

test('sqlite querySource executor leaves memory queries to the configured memory service', async () => {
  const executor = createSqliteSourceQueryExecutor({
    dbPath: join(tmpdir(), 'missing-yachiyo-source-query.sqlite')
  })

  const result = await executor.query({
    from: 'memories',
    where: { text: 'source database' },
    view: 'index'
  })

  assert.equal(result, undefined)
})
