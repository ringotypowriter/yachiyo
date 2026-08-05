import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord } from '@yachiyo/shared/protocol'

import { pageMessageWindow } from './messagePageWindow.ts'

const thread = Array.from({ length: 10 }, (_, index) => ({
  id: `message-${index + 1}`
})) as MessageRecord[]

const ids = (messages: MessageRecord[]): string[] => messages.map((message) => message.id)

/**
 * Every existing caller omits these options, and several of them build the
 * agent's context. Paging must stay something a caller opts into.
 */
test('without a limit the whole thread comes back unchanged', () => {
  assert.equal(pageMessageWindow(thread), thread)
  assert.equal(pageMessageWindow(thread, {}), thread)
  assert.equal(pageMessageWindow(thread, { beforeMessageId: 'message-5' }), thread)
})

test('the first page is the newest messages, still in reading order', () => {
  assert.deepEqual(ids(pageMessageWindow(thread, { limit: 3 })), [
    'message-8',
    'message-9',
    'message-10'
  ])
})

test('a cursor continues strictly above the message it names', () => {
  assert.deepEqual(ids(pageMessageWindow(thread, { limit: 3, beforeMessageId: 'message-8' })), [
    'message-5',
    'message-6',
    'message-7'
  ])
})

test('the top of a thread returns what is left rather than a padded page', () => {
  assert.deepEqual(ids(pageMessageWindow(thread, { limit: 3, beforeMessageId: 'message-2' })), [
    'message-1'
  ])
})

/** An empty page is how the caller learns to stop asking. */
test('paging past the first message returns nothing', () => {
  assert.deepEqual(pageMessageWindow(thread, { limit: 3, beforeMessageId: 'message-1' }), [])
})

/**
 * The failure that would look like working software: falling back to the
 * newest page would re-serve the same messages forever while the user
 * scrolled, so an unknown cursor has to be empty instead.
 */
test('an unknown cursor returns nothing rather than restarting from the newest', () => {
  assert.deepEqual(pageMessageWindow(thread, { limit: 3, beforeMessageId: 'not-here' }), [])
})

test('a limit larger than the thread returns the whole thread', () => {
  assert.deepEqual(ids(pageMessageWindow(thread, { limit: 50 })), ids(thread))
})

test('a zero limit returns nothing rather than everything', () => {
  assert.deepEqual(pageMessageWindow(thread, { limit: 0 }), [])
})

test('walking the whole thread backwards visits every message exactly once', () => {
  const seen: string[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 20; guard += 1) {
    const page = pageMessageWindow(thread, { limit: 3, ...(cursor ? { beforeMessageId: cursor } : {}) })
    if (page.length === 0) break
    seen.unshift(...ids(page))
    cursor = page[0]?.id
  }
  assert.deepEqual(seen, ids(thread), 'no gaps and no repeats across pages')
})

test('an empty thread pages to nothing', () => {
  assert.deepEqual(pageMessageWindow([], { limit: 5 }), [])
})
