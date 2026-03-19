import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { createSqliteYachiyoStorage } from './database.ts'
import { createSqliteYachiyoServer } from '../../app/YachiyoServer.ts'

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
const SqliteDatabase = ((BetterSqlite3 as { default?: unknown }).default ?? BetterSqlite3) as new (
  path: string
) => {
  close(): void
  prepare(sql: string): {
    all(): Array<{ name: string }>
  }
}

interface RunCompletionTracker {
  wait(runId: string): Promise<void>
  close(): void
}

function createRunCompletionTracker(
  server: ReturnType<typeof createSqliteYachiyoServer>
): RunCompletionTracker {
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
    assert.ok(tables.includes('tool_calls'))
    assert.ok(
      db
        .prepare('PRAGMA table_info(messages)')
        .all()
        .some((row) => row.name === 'model_id')
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(messages)')
        .all()
        .some((row) => row.name === 'provider_name')
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(messages)')
        .all()
        .some((row) => row.name === 'parent_message_id')
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(messages)')
        .all()
        .some((row) => row.name === 'images')
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .some((row) => row.name === 'head_message_id')
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .some((row) => row.name === 'branch_from_thread_id')
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .some((row) => row.name === 'branch_from_message_id')
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .some((row) => row.name === 'queued_follow_up_message_id')
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(runs)')
        .all()
        .some((row) => row.name === 'request_message_id')
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(runs)')
        .all()
        .some((row) => row.name === 'assistant_message_id')
    )

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
  const ensureThreadWorkspace = async (threadId: string): Promise<string> => {
    const workspacePath = join(root, '.yachiyo', 'temp-workspace', threadId)
    await mkdir(workspacePath, { recursive: true })
    return workspacePath
  }

  try {
    server = createSqliteYachiyoServer({
      dbPath,
      settingsPath,
      ensureThreadWorkspace,
      createModelRuntime: () => ({
        async *streamReply() {
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
      settingsPath,
      ensureThreadWorkspace
    })
    const bootstrap = await reopened.bootstrap()

    assert.equal(bootstrap.threads.length, 1)
    assert.equal(bootstrap.threads[0]?.title, 'Persist this thread')
    assert.equal(bootstrap.threads[0]?.preview, 'Hello from sqlite')
    assert.equal(
      bootstrap.threads[0]?.headMessageId,
      bootstrap.messagesByThread[thread.id]?.[1]?.id
    )
    assert.equal(bootstrap.messagesByThread[thread.id]?.length, 2)
    assert.equal(bootstrap.messagesByThread[thread.id]?.[0]?.role, 'user')
    assert.equal(
      bootstrap.messagesByThread[thread.id]?.[1]?.parentMessageId,
      bootstrap.messagesByThread[thread.id]?.[0]?.id
    )
    assert.equal(bootstrap.messagesByThread[thread.id]?.[1]?.content, 'Hello from sqlite')
    assert.equal(bootstrap.messagesByThread[thread.id]?.[1]?.modelId, 'gpt-5')
    assert.equal(bootstrap.messagesByThread[thread.id]?.[1]?.providerName, 'native')

    await reopened.close()
    reopened = null
  } finally {
    runTracker?.close()
    await reopened?.close()
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
})
