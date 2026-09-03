import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveScrollToMessageIntent,
  shouldKeepScrollToMessageIntent
} from './scrollToMessageIntent.ts'

test('a jump into a thread whose messages are not loaded yet waits for them', () => {
  // Uncached: the timeline has nothing, so the target cannot be found on this
  // render. Consuming the intent here loses the jump permanently.
  const outcome = resolveScrollToMessageIntent({ targetIndex: -1, hasOlderMessages: true })

  assert.equal(outcome, 'load-older')
  assert.equal(shouldKeepScrollToMessageIntent(outcome), true)
})

test('a jump to a message above the loaded page waits for older pages', () => {
  // Cached-partial: the newest page is on screen and the target sits above it.
  // This is the ordinary case once a thread opens on its newest page.
  const outcome = resolveScrollToMessageIntent({ targetIndex: -1, hasOlderMessages: true })

  assert.equal(outcome, 'load-older')
  assert.equal(shouldKeepScrollToMessageIntent(outcome), true)
})

test('a found target is scrolled to and the intent is consumed', () => {
  const outcome = resolveScrollToMessageIntent({ targetIndex: 12, hasOlderMessages: true })

  assert.equal(outcome, 'scroll')
  assert.equal(shouldKeepScrollToMessageIntent(outcome), false)
})

test('the first row is a valid target', () => {
  // Guards against an index check that treats 0 as "not found".
  assert.equal(resolveScrollToMessageIntent({ targetIndex: 0, hasOlderMessages: false }), 'scroll')
})

test('a target missing from a fully loaded thread is abandoned rather than retried forever', () => {
  // Nothing more can arrive, so keeping the intent would re-run the lookup on
  // every render for a message that does not exist here.
  const outcome = resolveScrollToMessageIntent({ targetIndex: -1, hasOlderMessages: false })

  assert.equal(outcome, 'abandon')
  assert.equal(shouldKeepScrollToMessageIntent(outcome), false)
})
