import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldRevertPendingComposerMessagesOnArrowUp } from './composerArrowUpRevert.ts'

test('allows ArrowUp revert only when the composer is truly empty', () => {
  assert.equal(
    shouldRevertPendingComposerMessagesOnArrowUp({
      key: 'ArrowUp',
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      hasPayload: false,
      hasPendingSteer: true,
      hasQueuedFollowUp: false
    }),
    true
  )
})

test('does not treat attachment-only drafts as empty for ArrowUp revert', () => {
  assert.equal(
    shouldRevertPendingComposerMessagesOnArrowUp({
      key: 'ArrowUp',
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      hasPayload: true,
      hasPendingSteer: true,
      hasQueuedFollowUp: false
    }),
    false
  )
})

test('ignores ArrowUp revert when modifiers are pressed or no pending message exists', () => {
  assert.equal(
    shouldRevertPendingComposerMessagesOnArrowUp({
      key: 'ArrowUp',
      metaKey: true,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      hasPayload: false,
      hasPendingSteer: true,
      hasQueuedFollowUp: false
    }),
    false
  )

  assert.equal(
    shouldRevertPendingComposerMessagesOnArrowUp({
      key: 'ArrowUp',
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      hasPayload: false,
      hasPendingSteer: false,
      hasQueuedFollowUp: false
    }),
    false
  )
})
