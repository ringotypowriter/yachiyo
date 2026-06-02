import assert from 'node:assert/strict'
import test from 'node:test'

import type { ThreadRecord } from '@yachiyo/shared/protocol'
import { createInMemoryYachiyoStorage } from './memoryStorage.ts'
import { toThreadRecord } from './storage.ts'

const NOW = '2026-05-18T00:00:00.000Z'

test('in-memory storage persists todo items on thread snapshots', () => {
  const storage = createInMemoryYachiyoStorage()
  const thread: ThreadRecord = {
    id: 'thread-todo',
    title: 'Thread with todo',
    updatedAt: NOW,
    todoItems: [
      { id: 'todo-1', content: 'Inspect the flow', status: 'completed' },
      { id: 'todo-2', content: 'Persist the widget', status: 'in_progress' }
    ]
  }

  storage.createThread({ thread, createdAt: NOW })

  const created = storage.bootstrap().threads.find((item) => item.id === thread.id)
  assert.deepEqual(created?.todoItems, thread.todoItems)

  const updatedThread: ThreadRecord = {
    ...thread,
    todoItems: [
      { id: 'todo-1', content: 'Inspect the flow', status: 'completed' },
      { id: 'todo-2', content: 'Persist the widget', status: 'completed' }
    ]
  }
  storage.updateThread(updatedThread)

  const updated = storage.bootstrap().threads.find((item) => item.id === thread.id)
  assert.deepEqual(updated?.todoItems, updatedThread.todoItems)
})

test('thread conversion parses persisted todo items', () => {
  const thread = toThreadRecord({
    archivedAt: null,
    starredAt: null,
    branchFromMessageId: null,
    branchFromThreadId: null,
    handoffFromThreadId: null,
    folderId: null,
    colorTag: null,
    headMessageId: null,
    icon: null,
    id: 'thread-1',
    memoryRecallState: null,
    modelOverride: null,
    preview: null,
    privacyMode: null,
    reasoningEffort: null,
    source: 'local',
    channelUserId: null,
    channelGroupId: null,
    rollingSummary: null,
    summaryWatermarkMessageId: null,
    readAt: null,
    createdFromEssentialId: null,
    createdFromScheduleId: null,
    runtimeBinding: null,
    lastDelegatedSession: null,
    recapText: null,
    todoItems: JSON.stringify([
      { id: 'todo-1', content: 'Inspect the flow', status: 'completed' },
      { id: 'todo-2', content: 'Persist the widget', status: 'in_progress' }
    ]),
    title: 'Thread',
    updatedAt: NOW,
    workspacePath: null
  })

  assert.deepEqual(thread.todoItems, [
    { id: 'todo-1', content: 'Inspect the flow', status: 'completed' },
    { id: 'todo-2', content: 'Persist the widget', status: 'in_progress' }
  ])
})
