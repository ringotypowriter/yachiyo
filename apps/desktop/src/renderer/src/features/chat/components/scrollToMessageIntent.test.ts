import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveScrollToMessageIntent,
  shouldKeepScrollToMessageIntent
} from './scrollToMessageIntent.ts'

test('a jump to a message that is not loaded yet keeps the intent', () => {
  // The thread still has older messages, so the read already in flight can
  // land the target. Consuming the intent here loses the jump permanently;
  // which of the two absent states this is (nothing loaded, or loaded but the
  // target is above the page) is decided by resolveThreadOpenRead, not here.
  const outcome = resolveScrollToMessageIntent({ targetIndex: -1, hasOlderMessages: true })

  assert.equal(outcome, 'wait')
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
