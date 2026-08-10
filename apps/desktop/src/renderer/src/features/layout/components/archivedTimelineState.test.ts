import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveArchivedTimelineState } from './archivedTimelineState.ts'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'

test('a server refresh takes precedence over an archived timeline load', () => {
  const state = resolveArchivedTimelineState({
    loadedMessages: [
      {
        id: 'message-old',
        threadId: 'thread-1',
        role: 'user',
        content: 'Old loaded state',
        status: 'completed',
        createdAt: TIMESTAMP
      }
    ],
    loadedToolCalls: [
      {
        id: 'tool-old',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'old.txt',
        startedAt: TIMESTAMP
      }
    ],
    refreshedMessages: [
      {
        id: 'message-new',
        threadId: 'thread-1',
        role: 'user',
        content: 'Fresh synced state',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      }
    ],
    refreshedToolCalls: [
      {
        id: 'tool-new',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'pwd',
        startedAt: '2026-03-15T00:00:01.000Z'
      }
    ]
  })

  assert.deepEqual(
    state.messages.map((message) => message.id),
    ['message-new']
  )
  assert.deepEqual(
    state.toolCalls.map((toolCall) => toolCall.id),
    ['tool-new']
  )
})
