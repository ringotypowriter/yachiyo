import assert from 'node:assert/strict'
import test from 'node:test'

import { canRetryAssistantMessage } from './messageActionState.ts'

test('canRetryAssistantMessage disables retry while the thread already has an active run', () => {
  assert.equal(
    canRetryAssistantMessage({
      messageStatus: 'completed',
      threadHasActiveRun: true
    }),
    false
  )
})

test('canRetryAssistantMessage disables retry for streaming replies and enables it otherwise', () => {
  assert.equal(
    canRetryAssistantMessage({
      messageStatus: 'streaming',
      threadHasActiveRun: false
    }),
    false
  )

  assert.equal(
    canRetryAssistantMessage({
      messageStatus: 'completed',
      threadHasActiveRun: false
    }),
    true
  )
})
