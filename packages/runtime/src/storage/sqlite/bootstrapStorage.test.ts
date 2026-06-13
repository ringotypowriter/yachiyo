import assert from 'node:assert/strict'
import test from 'node:test'

import { createSqliteBootstrapStorageMethods } from './bootstrapStorage.ts'
import {
  channelUsersTable,
  messagesTable,
  runsTable,
  threadFoldersTable,
  threadsTable,
  toolCallsTable
} from './schema.ts'

const timestamp = '2026-05-19T00:00:00.000Z'

function createThreadRow(
  id: string
): Parameters<Parameters<typeof createSqliteBootstrapStorageMethods>[0]['isBootstrapThread']>[0] {
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
            : table === channelUsersTable || table === runsTable || table === threadFoldersTable
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
    db: db as never,
    isBootstrapThread: () => true,
    toThreadRecordWithChannelUserRole: (row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt
    })
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
