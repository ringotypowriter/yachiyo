import assert from 'node:assert/strict'
import test from 'node:test'

import {
  retireJumpIntentOnThreadSwitch,
  type JumpIntentSelection
} from './serverEventJumpIntent.ts'

const liveJump: JumpIntentSelection = {
  activeThreadId: 'thread-1',
  activeArchivedThreadId: 'archived-1',
  scrollToMessage: { threadId: 'thread-1', messageId: 'message-1' }
}

const archivedJump: JumpIntentSelection = {
  activeThreadId: 'thread-1',
  activeArchivedThreadId: 'archived-1',
  scrollToMessage: { threadId: 'archived-1', messageId: 'message-a' }
}

test('a switch away from the thread the jump names retires it', () => {
  const next = retireJumpIntentOnThreadSwitch(liveJump, { activeThreadId: 'thread-2' })

  assert.equal(next.scrollToMessage, null)
})

test('a switch in the archived view retires an archived jump', () => {
  const next = retireJumpIntentOnThreadSwitch(archivedJump, {
    activeArchivedThreadId: 'archived-2'
  })

  assert.equal(next.scrollToMessage, null)
})

test("the other view moving is none of the jump's business", () => {
  // The reader is in the live view. Some archived thread being deleted in the
  // background changes activeArchivedThreadId, which must not touch a jump
  // that belongs to the thread still on screen.
  const next = retireJumpIntentOnThreadSwitch(liveJump, {
    activeArchivedThreadId: 'archived-2'
  })

  assert.deepEqual(next.scrollToMessage, undefined)
})

test('an archived jump survives the live view moving', () => {
  const next = retireJumpIntentOnThreadSwitch(archivedJump, { activeThreadId: 'thread-2' })

  assert.deepEqual(next.scrollToMessage, undefined)
})

test('an event that moves neither selection leaves the jump alone', () => {
  const next = retireJumpIntentOnThreadSwitch(liveJump, { activeThreadId: 'thread-1' })

  assert.deepEqual(next.scrollToMessage, undefined)
})

test('an event that brings its own jump keeps it', () => {
  // The new intent is about the thread being switched to.
  const next = retireJumpIntentOnThreadSwitch(liveJump, {
    activeThreadId: 'thread-2',
    scrollToMessage: { threadId: 'thread-2', messageId: 'message-2' }
  })

  assert.deepEqual(next.scrollToMessage, { threadId: 'thread-2', messageId: 'message-2' })
})

test('with no jump pending there is nothing to retire', () => {
  const next = retireJumpIntentOnThreadSwitch(
    { ...liveJump, scrollToMessage: null },
    { activeThreadId: 'thread-2' }
  )

  assert.equal(next.scrollToMessage, undefined)
})
