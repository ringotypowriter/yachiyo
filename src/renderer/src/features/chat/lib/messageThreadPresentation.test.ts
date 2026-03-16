import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMessageGroups } from './messageThreadPresentation.ts'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'

test('buildMessageGroups keeps retry replies under the same user request anchor', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-2'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'user-2',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-1',
        content: 'Second question',
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-2',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-2',
        content: 'Second answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z'
      },
      {
        id: 'assistant-retry',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Retry answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:04.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.userMessage.id, 'user-1')
  assert.equal(groups[0]?.activeBranchIndex, 0)
  assert.deepEqual(
    groups[0]?.assistantBranches.map((branch) => ({
      id: branch.message.id,
      isActive: branch.isActive
    })),
    [
      { id: 'assistant-1', isActive: true },
      { id: 'assistant-retry', isActive: false }
    ]
  )
  assert.equal(groups[1]?.userMessage.id, 'user-2')
  assert.deepEqual(
    groups[1]?.assistantBranches.map((branch) => branch.message.id),
    ['assistant-2']
  )
})

test('buildMessageGroups shows a preparing slot on the retried historical request before the first token arrives', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-1'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      }
    ],
    runPhase: 'preparing',
    activeRequestMessageId: 'user-1'
  })

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.showPreparing, true)
  assert.equal(groups[0]?.activeBranchIndex, 0)
})

test('buildMessageGroups hides downstream messages while a historical retry is preparing', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-2'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'user-2',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-1',
        content: 'Second question',
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-2',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-2',
        content: 'Second answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z'
      }
    ],
    runPhase: 'preparing',
    activeRequestMessageId: 'user-1'
  })

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.userMessage.id, 'user-1')
  assert.equal(groups[0]?.showPreparing, true)
})

test('buildMessageGroups treats the newest assistant branch as active while a retry is streaming', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-2'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'user-2',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-1',
        content: 'Second question',
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-2',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-2',
        content: 'Second answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z'
      },
      {
        id: 'assistant-retry',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Retry answer',
        status: 'streaming',
        createdAt: '2026-03-15T00:00:04.000Z'
      }
    ],
    runPhase: 'streaming',
    activeRequestMessageId: 'user-1'
  })

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.activeBranchIndex, 1)
  assert.deepEqual(
    groups[0]?.assistantBranches.map((branch) => ({
      id: branch.message.id,
      isActive: branch.isActive
    })),
    [
      { id: 'assistant-1', isActive: false },
      { id: 'assistant-retry', isActive: true }
    ]
  )
})
