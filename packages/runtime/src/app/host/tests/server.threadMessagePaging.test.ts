import assert from 'node:assert/strict'
import test from 'node:test'

import { YachiyoServer } from '../YachiyoServer.ts'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import type { MessageRecord } from '@yachiyo/shared/protocol'

/**
 * Thread paging is opt-in at this seam, and that is the whole point.
 *
 * `loadThreadData` has three consumers: the renderer opening a thread (which
 * wants a page) and the two sync-refresh events (which push a thread's whole
 * state to the UI). A default page here would silently truncate what a synced
 * thread shows — a defect with no error and no crash, just older messages
 * quietly missing after another device edits the thread.
 */

const THREAD_ID = 'thread-1'
const MESSAGE_COUNT = 10

function messageId(position: number): string {
  return `message-${String(position).padStart(2, '0')}`
}

function seedThread(storage: ReturnType<typeof createInMemoryYachiyoStorage>): void {
  const messages: MessageRecord[] = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
    id: messageId(index + 1),
    threadId: THREAD_ID,
    ...(index === 0 ? {} : { parentMessageId: messageId(index) }),
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `Message ${index + 1}`,
    status: 'completed' as const,
    createdAt: `2026-03-20T00:00:${String(index + 1).padStart(2, '0')}.000Z`
  }))
  storage.createThread({
    thread: { id: THREAD_ID, title: 'Thread', updatedAt: '2026-03-20T00:00:00.000Z' },
    createdAt: '2026-03-20T00:00:00.000Z',
    messages
  })
}

function ids(messages: { id: string }[]): string[] {
  return messages.map((message) => message.id)
}

test('a thread read without paging options returns the whole thread', () => {
  const storage = createInMemoryYachiyoStorage()
  seedThread(storage)
  const server = new YachiyoServer({ storage })

  const { messages } = server.loadThreadData(THREAD_ID)

  // The sync-refresh events call it exactly like this. If a page ever became
  // the default, a thread edited on another device would come back missing its
  // older half, and nothing would report an error.
  assert.equal(messages.length, MESSAGE_COUNT)
  assert.equal(messages[0]?.id, messageId(1))

  storage.close()
})

test('a limit returns the newest page, still in reading order', () => {
  const storage = createInMemoryYachiyoStorage()
  seedThread(storage)
  const server = new YachiyoServer({ storage })

  const { messages } = server.loadThreadData(THREAD_ID, { limit: 3 })

  assert.deepEqual(ids(messages), [messageId(8), messageId(9), messageId(10)])

  storage.close()
})

test('a cursor walks backwards from an earlier message', () => {
  const storage = createInMemoryYachiyoStorage()
  seedThread(storage)
  const server = new YachiyoServer({ storage })

  const { messages } = server.loadThreadData(THREAD_ID, {
    limit: 3,
    beforeMessageId: messageId(8)
  })

  assert.deepEqual(ids(messages), [messageId(5), messageId(6), messageId(7)])

  storage.close()
})
