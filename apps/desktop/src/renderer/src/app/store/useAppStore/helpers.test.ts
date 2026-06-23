import assert from 'node:assert/strict'
import test from 'node:test'

import type { Thread } from '../../types.ts'
import { DEFAULT_THREAD_TITLE, isThreadReusableNewChat } from './helpers.ts'

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: 't1',
    title: DEFAULT_THREAD_TITLE,
    updatedAt: '2026-06-23T00:00:00.000Z',
    ...overrides
  } as Thread
}

const emptyInput = {
  composerDrafts: {},
  messages: {},
  pendingWorkspacePath: null
}

test('isThreadReusableNewChat reuses a blank local New Chat', () => {
  assert.equal(isThreadReusableNewChat(emptyInput, thread({})), true)
})

test('isThreadReusableNewChat never reuses a synced read-only thread', () => {
  // A synced archive is read-only on this device; reusing it as the new-chat slot
  // would strand the user on a thread they cannot type into. Even when it looks
  // like a blank "New Chat", it must not be picked.
  const synced = thread({ syncOriginDeviceId: 'mac-b' })
  assert.equal(isThreadReusableNewChat(emptyInput, synced), false)
})
