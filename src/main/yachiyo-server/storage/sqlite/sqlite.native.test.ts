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
  exec(sql: string): void
  prepare(sql: string): {
    all(): Array<{ name: string }>
    run(...params: unknown[]): void
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
    assert.ok(
      db
        .prepare('PRAGMA table_info(tool_calls)')
        .all()
        .some((row) => row.name === 'request_message_id')
    )
    assert.ok(
      db
        .prepare('PRAGMA table_info(tool_calls)')
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

test('sqlite migrations backfill tool call message anchors from historical runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sqlite-native-'))
  const dbPath = join(root, 'native.sqlite')
  const migrationTimes = [
    1773678990559,
    1773720356847,
    1773721712396,
    1773733715724,
    1773892989412,
    1773907329656
  ]

  try {
    const db = new SqliteDatabase(dbPath)
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE threads (
        id text PRIMARY KEY NOT NULL,
        title text NOT NULL,
        preview text,
        branch_from_thread_id text,
        branch_from_message_id text,
        head_message_id text,
        archived_at text,
        updated_at text NOT NULL,
        created_at text NOT NULL,
        queued_follow_up_message_id text,
        queued_follow_up_enabled_tools text
      );
      CREATE TABLE messages (
        id text PRIMARY KEY NOT NULL,
        thread_id text NOT NULL,
        parent_message_id text,
        role text NOT NULL,
        content text NOT NULL,
        images text,
        status text NOT NULL,
        created_at text NOT NULL,
        model_id text,
        provider_name text,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE cascade,
        FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE cascade
      );
      CREATE TABLE runs (
        id text PRIMARY KEY NOT NULL,
        thread_id text NOT NULL,
        request_message_id text,
        status text NOT NULL,
        error text,
        created_at text NOT NULL,
        completed_at text,
        assistant_message_id text,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE cascade,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE set null,
        FOREIGN KEY (assistant_message_id) REFERENCES messages(id) ON DELETE set null
      );
      CREATE TABLE tool_calls (
        id text PRIMARY KEY NOT NULL,
        run_id text NOT NULL,
        thread_id text NOT NULL,
        tool_name text NOT NULL,
        status text NOT NULL,
        input_summary text NOT NULL,
        output_summary text,
        cwd text,
        error text,
        started_at text NOT NULL,
        finished_at text,
        details text,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE cascade,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE cascade
      );
      CREATE TABLE __drizzle_migrations (
        id integer PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      );
    `)

    for (const createdAt of migrationTimes) {
      db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
        `migration-${createdAt}`,
        createdAt
      )
    }

    db.prepare(
      'INSERT INTO threads (id, title, preview, head_message_id, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'thread-1',
      'Persisted thread',
      'Tool preview',
      'assistant-1',
      '2026-03-20T00:00:02.000Z',
      '2026-03-20T00:00:00.000Z'
    )
    db.prepare(
      'INSERT INTO messages (id, thread_id, parent_message_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'user-1',
      'thread-1',
      null,
      'user',
      'List the workspace files.',
      'completed',
      '2026-03-20T00:00:00.000Z'
    )
    db.prepare(
      'INSERT INTO messages (id, thread_id, parent_message_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'assistant-1',
      'thread-1',
      'user-1',
      'assistant',
      'Done',
      'completed',
      '2026-03-20T00:00:02.000Z'
    )
    db.prepare(
      'INSERT INTO runs (id, thread_id, request_message_id, assistant_message_id, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'run-1',
      'thread-1',
      'user-1',
      'assistant-1',
      'completed',
      '2026-03-20T00:00:00.500Z',
      '2026-03-20T00:00:02.000Z'
    )
    db.prepare(
      'INSERT INTO tool_calls (id, run_id, thread_id, tool_name, status, input_summary, output_summary, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'tool-1',
      'run-1',
      'thread-1',
      'bash',
      'completed',
      'pwd',
      'exit 0',
      '2026-03-20T00:00:01.000Z',
      '2026-03-20T00:00:01.500Z'
    )
    db.close()

    const storage = createSqliteYachiyoStorage(dbPath)
    const bootstrap = storage.bootstrap()
    storage.close()

    assert.equal(bootstrap.toolCallsByThread['thread-1']?.length, 1)
    assert.equal(bootstrap.toolCallsByThread['thread-1']?.[0]?.requestMessageId, 'user-1')
    assert.equal(bootstrap.toolCallsByThread['thread-1']?.[0]?.assistantMessageId, 'assistant-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
