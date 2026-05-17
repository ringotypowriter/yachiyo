import assert from 'node:assert/strict'
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
