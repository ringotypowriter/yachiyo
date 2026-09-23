import assert from 'node:assert/strict'
import test from 'node:test'
import { createInMemoryYachiyoStorage } from './memoryStorage.ts'
import {
  seedThreadMessagePagingFixture,
  assertThreadMessagePagingContract
} from './threadMessagePagingContract.test.ts'

test('ID-restricted body reads compose with existing paging and remain thread-scoped', () => {
  const storage = createInMemoryYachiyoStorage()
  seedThreadMessagePagingFixture(storage)
  assertThreadMessagePagingContract(storage)
  const ids = (options: Parameters<typeof storage.listThreadMessages>[1]): string[] =>
    storage.listThreadMessages('thread-1', options).map((row) => row.id)
  assert.deepEqual(ids({ messageIds: [] }), [])
  assert.deepEqual(ids({ messageIds: ['message-01', 'message-08', 'other-message-1'] }), [
    'message-01',
    'message-08'
  ])
  assert.deepEqual(ids({ messageIds: ['message-01', 'message-08'], limit: 1 }), ['message-08'])
  assert.deepEqual(
    ids({ messageIds: ['message-01', 'message-08'], beforeMessageId: 'message-07', limit: 1 }),
    ['message-01']
  )
  assert.deepEqual(ids({ messageIds: ['message-01'], limit: 0 }), [])
  const topology = storage.listThreadMessageTopology('thread-1')
  assert.equal(topology.length, 10)
  assert.ok(topology.every((row) => !('content' in row) && !('responseMessages' in row)))
})

test('empty tool scope does not fall back to unscoped payloads; foreign IDs cannot leak tools', () => {
  const storage = createInMemoryYachiyoStorage()
  seedThreadMessagePagingFixture(storage)
  storage.createToolCall({
    id: 'foreign',
    threadId: 'thread-2',
    requestMessageId: 'other-message-1',
    toolName: 'bash',
    status: 'waiting-for-user',
    inputSummary: 'secret',
    startedAt: '2026-01-01',
    runId: 'foreign-run'
  })
  storage.createToolCall({
    id: 'local',
    threadId: 'thread-1',
    assistantMessageId: 'message-01',
    toolName: 'bash',
    status: 'completed',
    inputSummary: 'local',
    startedAt: '2026-01-01'
  })
  assert.equal(storage.hasThreadWaitingToolCall('thread-1'), false)
  assert.equal(storage.hasThreadWaitingToolCall('thread-2'), true)
  assert.deepEqual(storage.listThreadToolCalls('thread-1', { messageIds: [] }), [])
  assert.deepEqual(
    storage.listThreadToolCalls('thread-1', {
      messageIds: ['other-message-1'],
      activeRunId: 'foreign-run'
    }),
    []
  )
  assert.deepEqual(
    storage.listThreadToolCalls('thread-1', { messageIds: ['message-01'] }).map((row) => row.id),
    ['local']
  )
})
