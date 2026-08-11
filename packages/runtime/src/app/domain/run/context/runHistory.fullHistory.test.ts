import assert from 'node:assert/strict'
import test from 'node:test'

import { loadRunHistory } from './runHistory.ts'
import type { MessageRecord } from '@yachiyo/shared/protocol'

/**
 * The agent's context must not be paged.
 *
 * Thread paging exists for display: the renderer asks for the newest page and
 * loads older ones as the user scrolls up. The run context is a different
 * consumer of the same storage call, and it needs the whole conversation —
 * a limit applied here would not fail, it would make Yachiyo quietly forget
 * the earlier half of a long thread.
 *
 * What this test pins and what it does not: it pins that the history
 * assembler returns every message on the path it is given. It does **not**
 * pin the wiring that supplies `loadThreadMessages` in YachiyoServer — a limit
 * introduced at that provider would not fail this test. That seam is named in
 * the PR rather than left implied.
 */

const THREAD_ID = 'thread-1'
const MESSAGE_COUNT = 200

function linearThread(count: number): MessageRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const position = index + 1
    return {
      id: `message-${String(position).padStart(3, '0')}`,
      threadId: THREAD_ID,
      ...(index === 0 ? {} : { parentMessageId: `message-${String(index).padStart(3, '0')}` }),
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `Message ${position}`,
      status: 'completed' as const,
      createdAt: `2026-03-20T00:00:00.${String(position).padStart(3, '0')}Z`
    } as MessageRecord
  })
}

const noRepairs = { persistResponseMessagesRepairInBackground: () => undefined }

test('a long thread reaches the run context whole', () => {
  const messages = linearThread(MESSAGE_COUNT)
  const requestMessageId = messages[MESSAGE_COUNT - 1]?.id ?? ''

  const history = loadRunHistory(() => messages, noRepairs, THREAD_ID, requestMessageId)

  assert.equal(
    history.length,
    MESSAGE_COUNT,
    `the run context must see all ${MESSAGE_COUNT} messages, got ${history.length}`
  )
  // Named explicitly, because a truncation that keeps the newest messages is
  // the plausible one — it looks correct right up until the model is asked
  // about something said earlier.
  assert.equal(history[0]?.id, 'message-001', 'the oldest message must still be present')
})

test('the whole thread arrives in order', () => {
  const messages = linearThread(MESSAGE_COUNT)
  const requestMessageId = messages[MESSAGE_COUNT - 1]?.id ?? ''

  const history = loadRunHistory(() => messages, noRepairs, THREAD_ID, requestMessageId)

  assert.deepEqual(
    history.map((message) => message.id),
    messages.map((message) => message.id)
  )
})
