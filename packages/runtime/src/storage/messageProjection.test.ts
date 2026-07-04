import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord } from '@yachiyo/shared/protocol'
import { createInMemoryYachiyoStorage } from './memoryStorage.ts'

function seedThreadWithMessages(storage: ReturnType<typeof createInMemoryYachiyoStorage>): void {
  const thread = { id: 'thread-1', title: 'Thread', updatedAt: '2026-01-01T00:00:00.000Z' }
  storage.createThread({ thread, createdAt: thread.updatedAt })
  const user: MessageRecord = {
    id: 'msg-user',
    threadId: 'thread-1',
    role: 'user',
    content: 'hello',
    status: 'completed',
    createdAt: '2026-01-01T00:00:01.000Z'
  }
  const assistant: MessageRecord = {
    id: 'msg-assistant',
    threadId: 'thread-1',
    role: 'assistant',
    content: 'hi there',
    status: 'completed',
    createdAt: '2026-01-01T00:00:02.000Z',
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }]
  }
  storage.saveThreadMessage({ thread, updatedThread: thread, message: user })
  storage.saveThreadMessage({ thread, updatedThread: thread, message: assistant })
}

test('message point query and responseMessages projection', async (t) => {
  await t.test('getMessage returns the full record by id', () => {
    const storage = createInMemoryYachiyoStorage()
    seedThreadWithMessages(storage)

    const record = storage.getMessage('msg-assistant')
    assert.equal(record?.threadId, 'thread-1')
    assert.equal(record?.content, 'hi there')
    assert.equal(record?.responseMessages?.length, 1)
  })

  await t.test('getMessage returns undefined for unknown ids', () => {
    const storage = createInMemoryYachiyoStorage()
    seedThreadWithMessages(storage)

    assert.equal(storage.getMessage('missing'), undefined)
  })

  await t.test('listThreadMessages can omit responseMessages', () => {
    const storage = createInMemoryYachiyoStorage()
    seedThreadWithMessages(storage)

    const projected = storage.listThreadMessages('thread-1', { includeResponseMessages: false })
    assert.equal(projected.length, 2)
    const assistant = projected.find((m) => m.id === 'msg-assistant')
    assert.equal(assistant?.content, 'hi there')
    assert.equal(assistant?.responseMessages, undefined)
    // The stored record must stay intact for full loads.
    const full = storage.listThreadMessages('thread-1')
    assert.equal(full.find((m) => m.id === 'msg-assistant')?.responseMessages?.length, 1)
  })
})
