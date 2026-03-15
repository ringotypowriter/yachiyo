import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { createSqliteYachiyoStorage } from './database.ts'
import { createSqliteYachiyoServer } from './YachiyoServer.ts'
import type { ModelStreamRequest } from './types.ts'

const require = createRequire(import.meta.url)
const BetterSqlite3 = require('better-sqlite3') as
  | {
      default?: new (path: string) => {
        close(): void
        prepare(sql: string): {
          all(): Array<{ name: string }>
        }
      }
    }
  | (new (path: string) => {
      close(): void
      prepare(sql: string): {
        all(): Array<{ name: string }>
      }
    })
const SqliteDatabase = ((BetterSqlite3 as { default?: unknown }).default ??
  BetterSqlite3) as new (path: string) => {
  close(): void
  prepare(sql: string): {
    all(): Array<{ name: string }>
  }
}

function createRunCompletionTracker(server: ReturnType<typeof createSqliteYachiyoServer>) {
  const seen = new Map<string, { status: 'completed' } | { status: 'failed'; error: string }>()
  const waiters = new Map<
    string,
    {
      resolve: () => void
      reject: (error: Error) => void
    }
  >()

  const unsubscribe = server.subscribe((event) => {
    if (event.type !== 'run.completed' && event.type !== 'run.failed') {
      return
    }

    const nextState =
      event.type === 'run.completed'
        ? { status: 'completed' as const }
        : { status: 'failed' as const, error: event.error }

    seen.set(event.runId, nextState)

    const waiter = waiters.get(event.runId)
    if (!waiter) {
      return
    }

    waiters.delete(event.runId)

    if (nextState.status === 'completed') {
      waiter.resolve()
      return
    }

    waiter.reject(new Error(nextState.error))
  })

  return {
    wait(runId: string) {
      const nextState = seen.get(runId)

      if (nextState?.status === 'completed') {
        return Promise.resolve()
      }

      if (nextState?.status === 'failed') {
        return Promise.reject(new Error(nextState.error))
      }

      return new Promise<void>((resolve, reject) => {
        waiters.set(runId, { resolve, reject })
      })
    },
    close() {
      unsubscribe()
    }
  }
}

test('sqlite storage initializes migrations on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sqlite-native-'))
  const dbPath = join(root, 'native.sqlite')

  try {
    const storage = createSqliteYachiyoStorage(dbPath)
    storage.close()

    const db = new SqliteDatabase(dbPath)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name)

    assert.ok(tables.includes('__drizzle_migrations'))
    assert.ok(tables.includes('messages'))
    assert.ok(tables.includes('runs'))
    assert.ok(tables.includes('threads'))

    db.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sqlite-backed server persists state across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sqlite-native-'))
  const dbPath = join(root, 'native.sqlite')
  const settingsPath = join(root, 'config.toml')
  let server: ReturnType<typeof createSqliteYachiyoServer> | null = null
  let reopened: ReturnType<typeof createSqliteYachiyoServer> | null = null
  let runTracker: ReturnType<typeof createRunCompletionTracker> | null = null

  try {
    server = createSqliteYachiyoServer({
      dbPath,
      settingsPath,
      createModelRuntime: () => ({
        async *streamReply(_request: ModelStreamRequest) {
          await Promise.resolve()
          yield 'Hello from sqlite'
        }
      })
    })
    runTracker = createRunCompletionTracker(server)

    await server.upsertProvider({
      name: 'native',
      type: 'openai',
      apiKey: 'sk-native',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5'],
        disabled: []
      }
    })

    const thread = await server.createThread()
    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Persist this thread'
    })

    await runTracker.wait(accepted.runId)
    runTracker.close()
    runTracker = null
    await server.close()
    server = null

    reopened = createSqliteYachiyoServer({
      dbPath,
      settingsPath
    })
    const bootstrap = await reopened.bootstrap()

    assert.equal(bootstrap.threads.length, 1)
    assert.equal(bootstrap.threads[0]?.title, 'Persist this thread')
    assert.equal(bootstrap.threads[0]?.preview, 'Hello from sqlite')
    assert.equal(bootstrap.messagesByThread[thread.id]?.length, 2)
    assert.equal(bootstrap.messagesByThread[thread.id]?.[0]?.role, 'user')
    assert.equal(bootstrap.messagesByThread[thread.id]?.[1]?.content, 'Hello from sqlite')

    await reopened.close()
    reopened = null
  } finally {
    runTracker?.close()
    await reopened?.close()
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
})
