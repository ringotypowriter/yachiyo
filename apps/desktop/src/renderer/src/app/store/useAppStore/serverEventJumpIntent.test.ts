import assert from 'node:assert/strict'
import test from 'node:test'

import {
  retireJumpIntentOnThreadSwitch,
  type JumpIntentSelection
} from './serverEventJumpIntent.ts'

const liveView: JumpIntentSelection = {
  threadListMode: 'active',
  activeThreadId: 'thread-1',
  activeArchivedThreadId: 'archived-1',
  scrollToMessage: { threadId: 'thread-1', messageId: 'message-1' }
}

const archivedView: JumpIntentSelection = {
  threadListMode: 'archived',
  activeThreadId: 'thread-1',
  activeArchivedThreadId: 'archived-1',
  scrollToMessage: { threadId: 'archived-1', messageId: 'message-a' }
}

test('a switch away from the thread the jump names retires it', () => {
  const next = retireJumpIntentOnThreadSwitch(liveView, { activeThreadId: 'thread-2' })

  assert.equal(next.scrollToMessage, null)
})

test('a switch in the archived list retires an archived jump', () => {
  const next = retireJumpIntentOnThreadSwitch(archivedView, {
    activeArchivedThreadId: 'archived-2'
  })

  assert.equal(next.scrollToMessage, null)
})

test("the list that is not on screen moving is none of the jump's business", () => {
  // The reader is in the live list. An archived thread being deleted in the
  // background changes activeArchivedThreadId, which must not touch a jump
  // belonging to the thread still on screen.
  const next = retireJumpIntentOnThreadSwitch(liveView, {
    activeArchivedThreadId: 'archived-2'
  })

  assert.equal(next.scrollToMessage, undefined)
})

test('an archived jump survives the live list moving underneath it', () => {
  const next = retireJumpIntentOnThreadSwitch(archivedView, { activeThreadId: 'thread-2' })

  assert.equal(next.scrollToMessage, undefined)
})

test('the other list holding the same thread does not keep the jump alive', () => {
  // Archiving the open thread selects it in the archived list but leaves the
  // reader in the live one. Nothing on screen can consume the intent, so it
  // would hang around in the background until something else cleared it.
  const next = retireJumpIntentOnThreadSwitch(liveView, {
    activeThreadId: 'thread-2',
    activeArchivedThreadId: 'thread-1'
  })

  assert.equal(next.scrollToMessage, null)
})

test('a jump survives when the reader follows its thread into the archived list', () => {
  const next = retireJumpIntentOnThreadSwitch(liveView, {
    threadListMode: 'archived',
    activeArchivedThreadId: 'thread-1'
  })

  assert.equal(next.scrollToMessage, undefined)
})

test('an event that moves nothing leaves the jump alone', () => {
  const next = retireJumpIntentOnThreadSwitch(liveView, { activeThreadId: 'thread-1' })

  assert.equal(next.scrollToMessage, undefined)
})

test('an event that brings its own jump keeps it', () => {
  const next = retireJumpIntentOnThreadSwitch(liveView, {
    activeThreadId: 'thread-2',
    scrollToMessage: { threadId: 'thread-2', messageId: 'message-2' }
  })

  assert.deepEqual(next.scrollToMessage, { threadId: 'thread-2', messageId: 'message-2' })
})

test('with no jump pending there is nothing to retire', () => {
  const next = retireJumpIntentOnThreadSwitch(
    { ...liveView, scrollToMessage: null },
    { activeThreadId: 'thread-2' }
  )

  assert.equal(next.scrollToMessage, undefined)
})
