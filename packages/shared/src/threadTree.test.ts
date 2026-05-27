import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectMessagePath,
  pickLatestLeafId,
  pickReplacementHeadId,
  wouldCreateParentCycle
} from './threadTree.ts'
import type { MessageRecord } from './protocol.ts'

const THREAD_ID = 'thread-1'

function createMessage(input: {
  id: string
  createdAt: string
  parentMessageId?: string
  role?: MessageRecord['role']
}): MessageRecord {
  return {
    id: input.id,
    threadId: THREAD_ID,
    role: input.role ?? 'assistant',
    content: input.id,
    status: 'completed',
    createdAt: input.createdAt,
    ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {})
  }
}

test('collectMessagePath stops when parent links form a cycle', () => {
  const messages = [
    createMessage({
      id: 'assistant-a',
      parentMessageId: 'assistant-b',
      createdAt: '2026-03-31T00:00:00.000Z'
    }),
    createMessage({
      id: 'assistant-b',
      parentMessageId: 'assistant-a',
      createdAt: '2026-03-31T00:00:01.000Z'
    })
  ]

  assert.deepEqual(
    collectMessagePath(messages, 'assistant-a').map((message) => message.id),
    ['assistant-b', 'assistant-a']
  )
})

test('pickLatestLeafId tolerates descendant cycles', () => {
  const messages = [
    createMessage({
      id: 'assistant-a',
      parentMessageId: 'assistant-b',
      createdAt: '2026-03-31T00:00:00.000Z'
    }),
    createMessage({
      id: 'assistant-b',
      parentMessageId: 'assistant-a',
      createdAt: '2026-03-31T00:00:01.000Z'
    })
  ]

  assert.equal(pickLatestLeafId(messages, 'assistant-a'), 'assistant-a')
})

test('pickReplacementHeadId stops when ancestor links form a cycle', () => {
  const originalMessages = [
    createMessage({
      id: 'assistant-a',
      parentMessageId: 'assistant-b',
      createdAt: '2026-03-31T00:00:00.000Z'
    }),
    createMessage({
      id: 'assistant-b',
      parentMessageId: 'assistant-a',
      createdAt: '2026-03-31T00:00:01.000Z'
    })
  ]

  assert.equal(pickReplacementHeadId(originalMessages, [], 'assistant-a'), undefined)
})

test('wouldCreateParentCycle detects self and descendant parent links', () => {
  const messages = [
    createMessage({
      id: 'user-1',
      role: 'user',
      createdAt: '2026-03-31T00:00:00.000Z'
    }),
    createMessage({
      id: 'assistant-1',
      parentMessageId: 'user-1',
      createdAt: '2026-03-31T00:00:01.000Z'
    }),
    createMessage({
      id: 'user-2',
      role: 'user',
      parentMessageId: 'assistant-1',
      createdAt: '2026-03-31T00:00:02.000Z'
    })
  ]

  assert.equal(wouldCreateParentCycle(messages, 'user-1', 'user-1'), true)
  assert.equal(wouldCreateParentCycle(messages, 'user-1', 'user-2'), true)
  assert.equal(wouldCreateParentCycle(messages, 'user-2', 'assistant-1'), false)
})
