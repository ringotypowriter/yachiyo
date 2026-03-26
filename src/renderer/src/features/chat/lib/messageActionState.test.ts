import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canRetryAssistantMessage,
  canRetryUserMessage,
  resolveRetryTargetMessageId
} from './messageActionState.ts'

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

test('canRetryUserMessage only depends on whether the thread is already running', () => {
  assert.equal(
    canRetryUserMessage({
      threadHasActiveRun: true
    }),
    false
  )

  assert.equal(
    canRetryUserMessage({
      threadHasActiveRun: false
    }),
    true
  )
})

test('canRetryAssistantMessage disables retry while the thread is saving', () => {
  assert.equal(
    canRetryAssistantMessage({
      messageStatus: 'completed',
      threadHasActiveRun: false,
      threadIsSaving: true
    }),
    false
  )
})

test('canRetryUserMessage disables retry while the thread is saving', () => {
  assert.equal(
    canRetryUserMessage({
      threadHasActiveRun: false,
      threadIsSaving: true
    }),
    false
  )
})

test('resolveRetryTargetMessageId falls back to the user anchor for stopped replies', () => {
  assert.equal(
    resolveRetryTargetMessageId({
      userMessageId: 'user-1',
      activeAssistantMessage: {
        id: 'assistant-stopped',
        status: 'stopped'
      }
    }),
    'user-1'
  )

  assert.equal(
    resolveRetryTargetMessageId({
      userMessageId: 'user-1',
      activeAssistantMessage: {
        id: 'assistant-1',
        status: 'completed'
      }
    }),
    'assistant-1'
  )
})
