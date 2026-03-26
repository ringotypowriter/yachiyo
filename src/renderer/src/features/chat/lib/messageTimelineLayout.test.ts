import assert from 'node:assert/strict'
import test from 'node:test'

import { buildConversationGroupTimelineItems } from './messageTimelineLayout.ts'

test('buildConversationGroupTimelineItems keeps replies before memory recall and orders tools with the assistant by time', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: true,
    replyCount: 2,
    showPreparing: false,
    showGenerating: false,
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
    showGenerating: false,
    activeAssistantTextBlocks: [],
    visibleToolCalls: []
  })

  assert.deepEqual(items, [{ kind: 'preparing', key: 'preparing' }])
})

test('buildConversationGroupTimelineItems keeps the assistant ahead of tools when timestamps tie', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
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
    showGenerating: false,
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

test('buildConversationGroupTimelineItems keeps generating at the bottom of the run', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: true,
    activeAssistantTextBlocks: [
      {
        id: 'text-1',
        content: 'thinking',
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
        inputSummary: 'done',
        startedAt: '2026-03-22T00:00:02.000Z'
      }
    ]
  })

  assert.deepEqual(items, [
    { kind: 'assistant-text-block', key: 'text-1', textBlockId: 'text-1' },
    { kind: 'tool-call', key: 'tool-1', toolCallId: 'tool-1' },
    { kind: 'generating', key: 'generating' }
  ])
})

test('buildConversationGroupTimelineItems does not add generating before the first assistant text block exists', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeAssistantTextBlocks: [],
    visibleToolCalls: []
  })

  assert.deepEqual(items, [])
})

test('buildConversationGroupTimelineItems hides tool calls that started after the last text block for a failed message', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeBranchStatus: 'failed',
    activeAssistantTextBlocks: [
      {
        id: 'text-1',
        content: 'some partial text',
        createdAt: '2026-03-22T00:00:01.000Z'
      }
    ],
    visibleToolCalls: [
      {
        id: 'tool-before',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'before text',
        startedAt: '2026-03-22T00:00:00.500Z'
      },
      {
        id: 'tool-after',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'grep',
        status: 'completed',
        inputSummary: 'after text',
        startedAt: '2026-03-22T00:00:02.000Z'
      }
    ]
  })

  assert.deepEqual(items, [
    { kind: 'tool-call', key: 'tool-before', toolCallId: 'tool-before' },
    { kind: 'assistant-text-block', key: 'text-1', textBlockId: 'text-1' }
  ])
})

test('buildConversationGroupTimelineItems hides tool calls that started after the last text block for a stopped message', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeBranchStatus: 'stopped',
    activeAssistantTextBlocks: [
      {
        id: 'text-1',
        content: 'stopped mid-thought',
        createdAt: '2026-03-22T00:00:01.000Z'
      }
    ],
    visibleToolCalls: [
      {
        id: 'tool-after',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'after stop',
        startedAt: '2026-03-22T00:00:02.000Z'
      }
    ]
  })

  assert.deepEqual(items, [{ kind: 'assistant-text-block', key: 'text-1', textBlockId: 'text-1' }])
})

test('buildConversationGroupTimelineItems keeps all tool calls for a failed message when there are no text blocks', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeBranchStatus: 'failed',
    activeAssistantTextBlocks: [],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'failed',
        inputSummary: 'file.ts',
        startedAt: '2026-03-22T00:00:01.000Z'
      }
    ]
  })

  assert.deepEqual(items, [{ kind: 'tool-call', key: 'tool-1', toolCallId: 'tool-1' }])
})

test('buildConversationGroupTimelineItems keeps post-text tool calls for a completed message', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeBranchStatus: 'completed',
    activeAssistantTextBlocks: [
      {
        id: 'text-1',
        content: 'done',
        createdAt: '2026-03-22T00:00:01.000Z'
      }
    ],
    visibleToolCalls: [
      {
        id: 'tool-after',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'file.ts',
        startedAt: '2026-03-22T00:00:02.000Z'
      }
    ]
  })

  assert.deepEqual(items, [
    { kind: 'assistant-text-block', key: 'text-1', textBlockId: 'text-1' },
    { kind: 'tool-call', key: 'tool-after', toolCallId: 'tool-after' }
  ])
})
