import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { createSqliteBootstrapStorageMethods, selectLatestRunRows } from './bootstrapStorage.ts'
import {
  channelUsersTable,
  messagesTable,
  threadFoldersTable,
  threadsTable,
  toolCallsTable
} from './schema.ts'
import type { toThreadRecord } from '../storage.ts'

const timestamp = '2026-05-19T00:00:00.000Z'

function createThreadRow(id: string): Parameters<typeof toThreadRecord>[0] {
  return {
    archivedAt: null,
    starredAt: null,
    branchFromMessageId: null,
    branchFromThreadId: null,
    handoffFromThreadId: null,
    folderId: null,
    colorTag: null,
    headMessageId: null,
    icon: null,
    id,
    memoryRecallState: null,
    modelOverride: null,
    preview: null,
    privacyMode: null,
    reasoningEffort: null,
    source: 'local',
    channelUserId: null,
    channelGroupId: null,
    contextHandoffSummary: null,
    contextHandoffWatermarkMessageId: null,
    readAt: null,
    createdFromEssentialId: null,
    createdFromScheduleId: null,
    runtimeBinding: null,
    lastDelegatedSession: null,
    todoItems: null,
    recapText: null,
    title: 'Thread',
    updatedAt: timestamp,
    workspacePath: null
  }
}

test('sqlite bootstrap does not read message or tool-call bodies', () => {
  const selectedTables: unknown[] = []
  const db = {
    update: () => ({
      set: () => ({
        where: () => ({ run: () => undefined })
      })
    }),
    select: () => ({
      from: (table: unknown) => {
        selectedTables.push(table)
        assert.notEqual(table, messagesTable, 'bootstrap must not select from messages')
        assert.notEqual(table, toolCallsTable, 'bootstrap must not select from tool_calls')

        const rows =
          table === threadsTable
            ? [createThreadRow('thread-1')]
            : table === channelUsersTable || table === threadFoldersTable
              ? []
              : []

        return {
          where: () => ({
            orderBy: () => ({ all: () => rows }),
            all: () => rows
          }),
          orderBy: () => ({ all: () => rows }),
          all: () => rows
        }
      }
    })
  }

  const storage = createSqliteBootstrapStorageMethods({
    client: {
      prepare: () => ({ all: () => [] })
    } as never,
    db: db as never
  })

  const payload = storage.bootstrap()

  assert.ok(selectedTables.includes(threadsTable))
  assert.deepEqual(payload.messagesByThread, {})
  assert.deepEqual(payload.toolCallsByThread, {})
  assert.deepEqual(
    payload.threads.map((thread) => thread.id),
    ['thread-1']
  )
})

test('latest-run query returns one deterministic row per thread', () => {
  const client = new DatabaseSync(':memory:')
  client.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      request_message_id TEXT,
      assistant_message_id TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_prompt_tokens INTEGER,
      total_completion_tokens INTEGER,
      time_to_first_token_ms INTEGER,
      model_generation_duration_ms INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      model_id TEXT,
      provider_name TEXT,
      snapshot_file_count INTEGER,
      workspace_path TEXT
    );
    INSERT INTO runs (id, thread_id, status, created_at) VALUES
      ('run-old', 'thread-1', 'completed', '2026-05-19T00:00:00.000Z'),
      ('run-new-a', 'thread-1', 'completed', '2026-05-20T00:00:00.000Z'),
      ('run-new-b', 'thread-1', 'completed', '2026-05-20T00:00:00.000Z'),
      ('run-other', 'thread-2', 'failed', '2026-05-18T00:00:00.000Z');
  `)

  try {
    const rows = selectLatestRunRows(client as never)
    assert.deepEqual(rows.map((row) => row.id).sort(), ['run-new-b', 'run-other'])
  } finally {
    client.close()
  }
})
