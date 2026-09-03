import assert from 'node:assert/strict'
import test from 'node:test'

import { retireJumpIntentOnThreadSwitch } from './serverEventJumpIntent.ts'

const previous = { activeThreadId: 'thread-1', scrollToMessageId: 'message-1' }

test('a switch away from the thread the jump named retires it', () => {
  const next = retireJumpIntentOnThreadSwitch(previous, {
    activeThreadId: 'thread-2',
    scrollToMessageId: previous.scrollToMessageId
  })

  assert.equal(next.scrollToMessageId, null)
})

test('an event that leaves the active thread alone leaves the jump alone', () => {
  const next = retireJumpIntentOnThreadSwitch(previous, {
    activeThreadId: 'thread-1',
    scrollToMessageId: previous.scrollToMessageId
  })

  assert.equal(next.scrollToMessageId, 'message-1')
})

test('an event that does not touch the active thread leaves the jump alone', () => {
  // Most branches say nothing about the active thread at all.
  const next = retireJumpIntentOnThreadSwitch(previous, { scrollToMessageId: 'message-1' })

  assert.equal(next.scrollToMessageId, 'message-1')
})

test('an event that brings its own jump target keeps it across the switch', () => {
  // The new target belongs to the thread being switched to.
  const next = retireJumpIntentOnThreadSwitch(previous, {
    activeThreadId: 'thread-2',
    scrollToMessageId: 'message-2'
  })

  assert.equal(next.scrollToMessageId, 'message-2')
})

test('carrying the old value through a switch is not "bringing its own target"', () => {
  // Branches return the whole state, so the field is always present. Presence
  // alone must not be read as the branch having chosen it.
  const next = retireJumpIntentOnThreadSwitch(previous, {
    ...previous,
    activeThreadId: null
  })

  assert.equal(next.scrollToMessageId, null)
})
