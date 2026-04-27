import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord, ThreadRecord } from '../../../shared/yachiyo/protocol.ts'
import { createInMemoryYachiyoStorage } from './memoryStorage.ts'

const NOW = '2026-04-28T00:00:00.000Z'

function createGroupThread(): ThreadRecord {
  return {
    id: 'group-thread-1',
    title: 'Telegram group probe',
    source: 'telegram',
    channelGroupId: 'group-1',
    preview: 'Existing group preview',
    updatedAt: NOW
  }
}

test('in-memory storage preserves channel group ownership when updating a previewed group thread', () => {
  const storage = createInMemoryYachiyoStorage()
  const thread = createGroupThread()
  storage.createThread({ thread, createdAt: NOW })

  const loadedThread = storage.getThread(thread.id)
  assert.equal(loadedThread?.channelGroupId, 'group-1')

  const message: MessageRecord = {
    id: 'group-message-1',
    threadId: thread.id,
    role: 'assistant',
    content: 'Updated group probe history',
    hidden: true,
    status: 'completed',
    createdAt: '2026-04-28T00:00:01.000Z'
  }
  assert.ok(loadedThread)
  storage.saveThreadMessage({
    thread: loadedThread,
    updatedThread: {
      ...loadedThread,
      headMessageId: message.id,
      preview: message.content,
      updatedAt: message.createdAt
    },
    message
  })

  assert.equal(storage.findActiveGroupThread('group-1', 60_000)?.id, thread.id)
  assert.equal(storage.listThreadsByChannelGroupId('group-1').length, 1)
})
