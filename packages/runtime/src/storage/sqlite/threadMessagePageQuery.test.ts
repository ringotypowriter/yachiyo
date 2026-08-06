import assert from 'node:assert/strict'
import test from 'node:test'

import { QueryBuilder } from 'drizzle-orm/sqlite-core'

import { messagesTable } from './schema.ts'
import {
  buildThreadMessagePageQuery,
  type ThreadMessagePageArgs
} from './threadMessagePageQuery.ts'

/**
 * Compile the production query builder to SQL text without a database.
 *
 * better-sqlite3 here is built against Electron's ABI, so any test that opens a
 * real database can only run under Electron — and the Node runner excludes
 * `.native.test.ts` outright. Those files are therefore not a CI gate, and a
 * paging contract asserted only there would be asserted nowhere.
 *
 * What can be gated in Node is the SQL itself. These tests read the statement
 * the reader will actually send, so "the database does the limiting" becomes a
 * claim CI can falsify. They do not prove the rows come back correct — that
 * needs the native suite. They prove the work is pushed down.
 */
function compilePageQuery(args: ThreadMessagePageArgs): { sql: string; params: unknown[] } {
  const query = buildThreadMessagePageQuery(
    new QueryBuilder().select({ id: messagesTable.id }).from(messagesTable).$dynamic(),
    args
  )
  return query.toSQL()
}

test('the newest page is bounded by the database, not by the caller', () => {
  const { sql, params } = compilePageQuery({ threadId: 'thread-1', limit: 20 })

  assert.match(sql, /limit \?/)
  assert.ok(
    params.includes(20),
    `the limit must travel to sqlite as a parameter, got ${JSON.stringify(params)}`
  )
})

test('a page walks backwards from the newest message', () => {
  const { sql } = compilePageQuery({ threadId: 'thread-1', limit: 20 })

  // Newest-first at the database, reversed into reading order by the reader.
  // Ascending here would mean the "page" is the *oldest* messages.
  assert.match(sql, /order by .*"created_at" desc/)
})

test('equal timestamps still have one definite order', () => {
  const { sql } = compilePageQuery({ threadId: 'thread-1', limit: 20 })

  // Messages written in the same millisecond are common in a burst reply. With
  // created_at alone as the sort key their relative order is unspecified, so a
  // message can sit on both sides of a page boundary — duplicated in one page
  // and missing from the next.
  assert.match(sql, /order by .*"created_at" desc, .*"id" desc/)
})

test('the cursor is a predicate sqlite evaluates, not a slice taken afterwards', () => {
  const { sql, params } = compilePageQuery({
    threadId: 'thread-1',
    limit: 20,
    cursor: { createdAt: '2026-08-05T10:00:00.000Z', id: 'message-7' }
  })

  assert.match(sql, /"created_at" < \?/)
  assert.ok(
    params.includes('2026-08-05T10:00:00.000Z') && params.includes('message-7'),
    `both halves of the cursor must reach sqlite, got ${JSON.stringify(params)}`
  )
})

test('the cursor tie-break keeps a same-timestamp message from being skipped', () => {
  const { sql } = compilePageQuery({
    threadId: 'thread-1',
    limit: 20,
    cursor: { createdAt: '2026-08-05T10:00:00.000Z', id: 'message-7' }
  })

  // `created_at < cursor` alone drops every message sharing the cursor's
  // timestamp — they are neither on this page nor the previous one.
  assert.match(sql, /"created_at" = \?.*"id" < \?/s)
})

test('every page is scoped to its own thread', () => {
  const { sql, params } = compilePageQuery({ threadId: 'thread-1', limit: 20 })

  assert.match(sql, /"thread_id" = \?/)
  assert.ok(params.includes('thread-1'))
})

test('a whole-thread read stays unbounded', () => {
  const { sql } = compilePageQuery({ threadId: 'thread-1' })

  // Callers that want the entire thread must not silently receive a page.
  assert.doesNotMatch(sql, /limit \?/)
})

test('an empty page is asked of sqlite rather than faked', () => {
  const { sql, params } = compilePageQuery({ threadId: 'thread-1', limit: 0 })

  // `limit 0` is a legal, meaningful statement, and the in-memory store answers
  // a zero limit the same way. Neither store special-cases it.
  assert.match(sql, /limit \?/)
  assert.ok(params.includes(0))
})

test('a limit that cannot describe a page is refused at the boundary', () => {
  for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => compilePageQuery({ threadId: 'thread-1', limit }),
      /limit/i,
      `limit ${limit} must be refused rather than quietly producing a strange page`
    )
  }
})
