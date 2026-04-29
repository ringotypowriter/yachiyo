import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canCreateBranch,
  canDeleteMessage,
  canEditUserMessage,
  canRemoveQueuedFollowUp,
  canRetryAssistantMessage,
  canSelectReplyBranch,
  canRetryUserMessage,
  resolveRetryTargetMessageId
} from './messageActionState.ts'

const interactiveThreadCapabilities = {
  canRetry: true,
  canCreateBranch: true,
  canSelectReplyBranch: true,
  canEdit: true,
  canDelete: true
} as const

const acpThreadCapabilities = {
  canRetry: false,
  canCreateBranch: false,
  canSelectReplyBranch: false,
  canEdit: false,
  canDelete: false
} as const

test('canRetryAssistantMessage disables retry while the thread already has an active run', () => {
  assert.equal(
    canRetryAssistantMessage({
      messageStatus: 'completed',
      threadCapabilities: interactiveThreadCapabilities,
      threadHasActiveRun: true
    }),
    false
  )
})

test('canRetryAssistantMessage disables retry for streaming replies and enables it otherwise', () => {
  assert.equal(
    canRetryAssistantMessage({
      messageStatus: 'streaming',
      threadCapabilities: interactiveThreadCapabilities,
      threadHasActiveRun: false
    }),
    false
  )

  assert.equal(
    canRetryAssistantMessage({
      messageStatus: 'completed',
      threadCapabilities: interactiveThreadCapabilities,
      threadHasActiveRun: false
    }),
    true
  )
})

test('canRetryUserMessage only depends on whether the thread is already running', () => {
  assert.equal(
    canRetryUserMessage({
      threadCapabilities: interactiveThreadCapabilities,
      threadHasActiveRun: true
    }),
    false
  )

  assert.equal(
    canRetryUserMessage({
      threadCapabilities: interactiveThreadCapabilities,
      threadHasActiveRun: false
    }),
    true
  )
})

test('canRetryAssistantMessage disables retry while the thread is saving', () => {
  assert.equal(
    canRetryAssistantMessage({
      messageStatus: 'completed',
      threadCapabilities: interactiveThreadCapabilities,
      threadHasActiveRun: false,
      threadIsSaving: true
    }),
    false
  )
})

test('canRetryUserMessage disables retry while the thread is saving', () => {
  assert.equal(
    canRetryUserMessage({
      threadCapabilities: interactiveThreadCapabilities,
      threadHasActiveRun: false,
      threadIsSaving: true
    }),
    false
  )
})

test('ACP thread capabilities disable retry, branch, edit, and delete actions centrally', () => {
  assert.equal(
    canRetryAssistantMessage({
      messageStatus: 'completed',
      threadCapabilities: acpThreadCapabilities,
      threadHasActiveRun: false
    }),
    false
  )

  assert.equal(
    canRetryUserMessage({
      threadCapabilities: acpThreadCapabilities,
      threadHasActiveRun: false
    }),
    false
  )

  assert.equal(
    canCreateBranch({
      threadCapabilities: acpThreadCapabilities,
      threadHasActiveRun: false
    }),
    false
  )

  assert.equal(
    canSelectReplyBranch({
      threadCapabilities: acpThreadCapabilities,
      threadHasActiveRun: false
    }),
    false
  )

  assert.equal(
    canEditUserMessage({
      threadCapabilities: acpThreadCapabilities,
      threadHasActiveRun: false
    }),
    false
  )

  assert.equal(
    canDeleteMessage({
      threadCapabilities: acpThreadCapabilities,
      threadHasActiveRun: false
    }),
    false
  )
})

test('canRemoveQueuedFollowUp follows delete capability without blocking active runs', () => {
  assert.equal(
    canRemoveQueuedFollowUp({
      threadCapabilities: interactiveThreadCapabilities
    }),
    true
  )

  assert.equal(
    canRemoveQueuedFollowUp({
      threadCapabilities: acpThreadCapabilities
    }),
    false
  )
})

test('canEditUserMessage disables editing while the thread has an active run', () => {
  assert.equal(
    canEditUserMessage({
      threadCapabilities: interactiveThreadCapabilities,
      threadHasActiveRun: true
    }),
    false
  )
})

test('canEditUserMessage disables editing while the thread is saving', () => {
  assert.equal(
    canEditUserMessage({
      threadCapabilities: interactiveThreadCapabilities,
      threadHasActiveRun: false,
      threadIsSaving: true
    }),
    false
  )
})

test('canEditUserMessage allows editing when thread is idle', () => {
  assert.equal(
    canEditUserMessage({
      threadCapabilities: interactiveThreadCapabilities,
      threadHasActiveRun: false
    }),
    true
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
