import assert from 'node:assert/strict'
import test from 'node:test'

import { buildConversationGroupTimelineItems } from './messageTimelineLayout.ts'

test('buildConversationGroupTimelineItems keeps memory recall first and orders tools with the assistant by time', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: true,
    replyCount: 2,
    showPreparing: false,
    activeAssistantTextBlocks: [
      {
        id: 'text-0',
        content: 'start',
        createdAt: '2026-03-22T00:00:00.000Z'
      },
      {
        id: 'text-1',
        content: 'middle',
        createdAt: '2026-03-22T00:00:02.000Z'
      }
    ],
    visibleToolCalls: [
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'second',
        startedAt: '2026-03-22T00:00:03.000Z'
      },
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'write',
        status: 'completed',
        inputSummary: 'first',
        startedAt: '2026-03-22T00:00:01.000Z'
      }
    ]
  })

  assert.deepEqual(items, [
    { kind: 'memory-recall', key: 'memory-recall' },
    { kind: 'reply-nav', key: 'reply-nav' },
    { kind: 'assistant-text-block', key: 'text-0', textBlockId: 'text-0' },
    { kind: 'tool-call', key: 'tool-1', toolCallId: 'tool-1' },
    { kind: 'assistant-text-block', key: 'text-1', textBlockId: 'text-1' },
    { kind: 'tool-call', key: 'tool-2', toolCallId: 'tool-2' }
  ])
})

test('buildConversationGroupTimelineItems keeps preparing at the end while a historical retry is preparing', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 2,
    showPreparing: true,
    activeAssistantTextBlocks: [],
    visibleToolCalls: []
  })

  assert.deepEqual(items, [
    { kind: 'reply-nav', key: 'reply-nav' },
    { kind: 'preparing', key: 'preparing' }
  ])
})

test('buildConversationGroupTimelineItems keeps the assistant ahead of tools when timestamps tie', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    activeAssistantTextBlocks: [
      {
        id: 'text-1',
        content: 'same-time',
        createdAt: '2026-03-22T00:00:01.000Z'
      }
    ],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'same-time',
        startedAt: '2026-03-22T00:00:01.000Z'
      }
    ]
  })

  assert.deepEqual(items, [
    { kind: 'assistant-text-block', key: 'text-1', textBlockId: 'text-1' },
    { kind: 'tool-call', key: 'tool-1', toolCallId: 'tool-1' }
  ])
})

test('buildConversationGroupTimelineItems keeps assistant text blocks split around tools', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    activeAssistantTextBlocks: [
      {
        id: 'text-1',
        content: '```ts\nconst value = 1',
        createdAt: '2026-03-22T00:00:01.000Z'
      },
      {
        id: 'text-2',
        content: '\n```',
        createdAt: '2026-03-22T00:00:03.000Z'
      }
    ],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'between blocks',
        startedAt: '2026-03-22T00:00:02.000Z'
      }
    ]
  })

  assert.deepEqual(items, [
    { kind: 'assistant-text-block', key: 'text-1', textBlockId: 'text-1' },
    { kind: 'tool-call', key: 'tool-1', toolCallId: 'tool-1' },
    { kind: 'assistant-text-block', key: 'text-2', textBlockId: 'text-2' }
  ])
})
