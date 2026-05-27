import assert from 'node:assert/strict'
import test from 'node:test'

import { ensureThreadSearchIndex } from './threadSearchIndex.ts'

test('thread search FTS update triggers only run when indexed columns change', () => {
  const execSql: string[] = []
  const client = {
    exec(sql: string): void {
      execSql.push(sql)
    },
    prepare() {
      return {
        get: () => ({ count: 0 }),
        run: () => {}
      }
    }
  } as never

  ensureThreadSearchIndex(client)

  const ddl = execSql.join('\n')
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
