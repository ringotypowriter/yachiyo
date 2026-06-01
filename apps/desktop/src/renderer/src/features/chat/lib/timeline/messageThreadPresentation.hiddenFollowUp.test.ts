import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMessageGroups } from './messageThreadPresentation.ts'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'

const baseThread = {
  id: 'thread-1',
  title: 'Thread',
  updatedAt: TIMESTAMP,
  headMessageId: 'assistant-after-hidden'
}

const legacyHiddenPathMessages = [
  {
    id: 'user-1',
    threadId: 'thread-1',
    role: 'user' as const,
    content: 'Visible request',
    status: 'completed' as const,
    createdAt: TIMESTAMP
  },
  {
    id: 'assistant-before-hidden',
    threadId: 'thread-1',
    role: 'assistant' as const,
    parentMessageId: 'user-1',
    content: 'Initial visible answer',
    status: 'completed' as const,
    createdAt: '2026-03-15T00:00:01.000Z'
  },
  {
    id: 'hidden-request',
    threadId: 'thread-1',
    role: 'user' as const,
    parentMessageId: 'assistant-before-hidden',
    content: '[Background task completed]',
    hidden: true,
    status: 'completed' as const,
    createdAt: '2026-03-15T00:00:02.000Z'
  },
  {
    id: 'assistant-after-hidden',
    threadId: 'thread-1',
    role: 'assistant' as const,
    parentMessageId: 'hidden-request',
    content: 'Follow-up visible answer',
    status: 'completed' as const,
    createdAt: '2026-03-15T00:00:03.000Z'
  }
]

test('buildMessageGroups treats legacy hidden follow-up runs as separate assistant groups', () => {
  const groups = buildMessageGroups({
    thread: baseThread,
    messages: legacyHiddenPathMessages,
    runs: [
      {
        id: 'run-follow-up',
        threadId: 'thread-1',
        status: 'completed',
        requestMessageId: 'hidden-request',
        createdAt: '2026-03-15T00:00:02.000Z',
        completedAt: '2026-03-15T00:00:04.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.userMessage.id, 'user-1')
  assert.deepEqual(
    groups[0]?.activeAssistantMessages.map((message) => message.id),
    ['assistant-before-hidden']
  )
  assert.deepEqual(groups[0]?.hiddenRequestMessageIds, [])
  assert.equal(groups[1]?.userMessage.id, 'hidden-request')
  assert.equal(groups[1]?.userMessage.hidden, true)
  assert.deepEqual(
    groups[1]?.activeAssistantMessages.map((message) => message.id),
    ['assistant-after-hidden']
  )
})

test('buildMessageGroups keeps legacy hidden steers merged when their run predates the parent assistant', () => {
  const groups = buildMessageGroups({
    thread: baseThread,
    messages: legacyHiddenPathMessages,
    runs: [
      {
        id: 'run-steer',
        threadId: 'thread-1',
        status: 'completed',
        requestMessageId: 'hidden-request',
        createdAt: TIMESTAMP,
        completedAt: '2026-03-15T00:00:04.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.userMessage.id, 'user-1')
  assert.deepEqual(
    groups[0]?.activeAssistantMessages.map((message) => message.id),
    ['assistant-before-hidden', 'assistant-after-hidden']
  )
  assert.deepEqual(groups[0]?.hiddenRequestMessageIds, ['hidden-request'])
})
