import test from 'node:test'
import assert from 'node:assert/strict'

import { canChangeThreadWorkspace, isFreshHandoffWorkspaceThread } from './threadWorkspaceRules.ts'

test('canChangeThreadWorkspace allows an empty thread', () => {
  assert.equal(
    canChangeThreadWorkspace({
      messages: [],
      threadCreatedAt: '2026-03-31T00:00:00.000Z'
    }),
    true
  )
})

test('isFreshHandoffWorkspaceThread matches a single assistant bootstrap message', () => {
  assert.equal(
    isFreshHandoffWorkspaceThread({
      messages: [
        {
          createdAt: '2026-03-31T00:00:01.000Z',
          role: 'assistant',
          parentMessageId: undefined
        }
      ],
      threadCreatedAt: '2026-03-31T00:00:00.000Z'
    }),
    true
  )
})

test('canChangeThreadWorkspace allows a single assistant bootstrap message without threadCreatedAt', () => {
  assert.equal(
    canChangeThreadWorkspace({
      messages: [
        {
          createdAt: '2026-03-31T00:00:01.000Z',
          role: 'assistant',
          parentMessageId: undefined
        }
      ],
      threadCreatedAt: null
    }),
    true
  )
})

test('canChangeThreadWorkspace rejects a handoff thread after the first user continuation', () => {
  assert.equal(
    canChangeThreadWorkspace({
      messages: [
        {
          createdAt: '2026-03-31T00:00:01.000Z',
          role: 'assistant',
          parentMessageId: undefined
        },
        {
          createdAt: '2026-03-31T00:00:02.000Z',
          role: 'user',
          parentMessageId: 'assistant-1'
        }
      ],
      threadCreatedAt: '2026-03-31T00:00:00.000Z'
    }),
    false
  )
})

test('canChangeThreadWorkspace keeps branch snapshots editable before new messages are added', () => {
  assert.equal(
    canChangeThreadWorkspace({
      messages: [
        {
          createdAt: '2026-03-30T23:59:58.000Z',
          role: 'user',
          parentMessageId: undefined
        },
        {
          createdAt: '2026-03-30T23:59:59.000Z',
          role: 'assistant',
          parentMessageId: 'user-1'
        }
      ],
      threadCreatedAt: '2026-03-31T00:00:00.000Z'
    }),
    true
  )
})
