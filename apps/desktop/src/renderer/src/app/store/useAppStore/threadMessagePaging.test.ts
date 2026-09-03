import assert from 'node:assert/strict'
import test from 'node:test'

import type { Message } from '../../types.ts'
import {
  THREAD_MESSAGE_PAGE_SIZE,
  hasOlderThreadMessages,
  prependOlderThreadMessages,
  resolveThreadOpenRead
} from './threadMessagePaging.ts'

function message(id: string): Message {
  return { id, role: 'user', content: id } as Message
}

function ids(messages: Message[]): string[] {
  return messages.map((entry) => entry.id)
}

test('an older page is prepended ahead of what is already loaded', () => {
  const loaded = [message('m5'), message('m6')]

  const next = prependOlderThreadMessages(loaded, [message('m3'), message('m4')])

  assert.deepEqual(ids(next), ['m3', 'm4', 'm5', 'm6'])
})

test('a message already loaded is not duplicated by an older page', () => {
  // The live event stream can deliver a message the older page also contains.
  // Two copies of one message is worse than a missing page: the conversation
  // reads as if something was said twice.
  const loaded = [message('m4'), message('m5')]

  const next = prependOlderThreadMessages(loaded, [message('m3'), message('m4')])

  assert.deepEqual(ids(next), ['m3', 'm4', 'm5'])
})

test('an empty older page leaves the loaded list untouched', () => {
  const loaded = [message('m1'), message('m2')]

  // Returning the same array lets the timeline skip a re-render, which matters
  // because a re-render here re-runs the scroll-anchor correction.
  assert.equal(prependOlderThreadMessages(loaded, []), loaded)
})

test('a full page means there is probably more above it', () => {
  assert.equal(hasOlderThreadMessages(THREAD_MESSAGE_PAGE_SIZE), true)
})

test('a short page means the top of the thread has been reached', () => {
  assert.equal(hasOlderThreadMessages(THREAD_MESSAGE_PAGE_SIZE - 1), false)
  assert.equal(hasOlderThreadMessages(0), false)
})

test('opening a thread with nothing loaded reads the newest page', () => {
  assert.deepEqual(resolveThreadOpenRead({ loadedMessages: undefined }), {
    includeMessages: true,
    limit: THREAD_MESSAGE_PAGE_SIZE
  })
})

test('re-opening a loaded thread skips messages entirely', () => {
  assert.deepEqual(resolveThreadOpenRead({ loadedMessages: [message('m1')] }), {
    includeMessages: false
  })
})

test('jumping to a message that is not loaded reads the whole thread', () => {
  // Search results and Thing sources jump straight to an old message. Paging
  // made "the target is not loaded" a reachable state for the first time; a
  // page-sized read would land on the newest messages and the jump would
  // silently do nothing. These jumps are rare, so reading it whole is fine.
  assert.deepEqual(
    resolveThreadOpenRead({
      loadedMessages: [message('m9'), message('m10')],
      scrollToMessageId: 'm2'
    }),
    { includeMessages: true }
  )
})

test('jumping to a message that is already loaded does not re-read', () => {
  assert.deepEqual(
    resolveThreadOpenRead({
      loadedMessages: [message('m9'), message('m10')],
      scrollToMessageId: 'm10'
    }),
    { includeMessages: false }
  )
})

test('jumping into a thread with nothing loaded reads the whole thread', () => {
  assert.deepEqual(resolveThreadOpenRead({ loadedMessages: undefined, scrollToMessageId: 'm2' }), {
    includeMessages: true
  })
})
