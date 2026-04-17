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

test('buildConversationGroupTimelineItems keeps post-text tool calls for a completed message', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,

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

test('buildConversationGroupTimelineItems groups consecutive same-group tool calls', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeAssistantTextBlocks: [],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'a.ts',
        startedAt: '2026-03-22T00:00:01.000Z'
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'b.ts',
        startedAt: '2026-03-22T00:00:02.000Z'
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'c.ts',
        startedAt: '2026-03-22T00:00:03.000Z'
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'read-files',
      toolCallIds: ['tool-1', 'tool-2', 'tool-3']
    }
  ])
})

test('buildConversationGroupTimelineItems does not group same-group tool calls separated by a different tool call', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeAssistantTextBlocks: [],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'a.ts',
        startedAt: '2026-03-22T00:00:01.000Z'
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'write',
        status: 'completed',
        inputSummary: 'b.ts',
        startedAt: '2026-03-22T00:00:02.000Z'
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'c.ts',
        startedAt: '2026-03-22T00:00:03.000Z'
      },
      {
        id: 'tool-4',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'd.ts',
        startedAt: '2026-03-22T00:00:04.000Z'
      },
      {
        id: 'tool-5',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'e.ts',
        startedAt: '2026-03-22T00:00:05.000Z'
      },
      {
        id: 'tool-6',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'write',
        status: 'completed',
        inputSummary: 'f.ts',
        startedAt: '2026-03-22T00:00:06.000Z'
      }
    ]
  })

  assert.deepEqual(items, [
    { kind: 'tool-call', key: 'tool-1', toolCallId: 'tool-1' },
    { kind: 'tool-call', key: 'tool-2', toolCallId: 'tool-2' },
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-3',
      group: 'read-files',
      toolCallIds: ['tool-3', 'tool-4', 'tool-5']
    },
    { kind: 'tool-call', key: 'tool-6', toolCallId: 'tool-6' }
  ])
})

test('buildConversationGroupTimelineItems does not group same-group tool calls separated by a non-empty text block', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeAssistantTextBlocks: [
      {
        id: 'text-1',
        content: 'interleaved',
        createdAt: '2026-03-22T00:00:02.500Z'
      }
    ],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'a.ts',
        startedAt: '2026-03-22T00:00:01.000Z'
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'b.ts',
        startedAt: '2026-03-22T00:00:03.000Z'
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'c.ts',
        startedAt: '2026-03-22T00:00:04.000Z'
      }
    ]
  })

  // tool-1 is separated from tool-2/tool-3 by the text block, but
  // tool-2 and tool-3 are consecutive same-group (read-files) → grouped.
  assert.deepEqual(items, [
    { kind: 'tool-call', key: 'tool-1', toolCallId: 'tool-1' },
    { kind: 'assistant-text-block', key: 'text-1', textBlockId: 'text-1' },
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-2',
      group: 'read-files',
      toolCallIds: ['tool-2', 'tool-3']
    }
  ])
})

test('buildConversationGroupTimelineItems groups same-group tool calls across empty text blocks', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeAssistantTextBlocks: [
      {
        id: 'text-1',
        content: '',
        createdAt: '2026-03-22T00:00:02.500Z'
      }
    ],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'a.ts',
        startedAt: '2026-03-22T00:00:01.000Z'
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'b.ts',
        startedAt: '2026-03-22T00:00:03.000Z'
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'c.ts',
        startedAt: '2026-03-22T00:00:04.000Z'
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'read-files',
      toolCallIds: ['tool-1', 'tool-2', 'tool-3']
    },
    { kind: 'assistant-text-block', key: 'text-1', textBlockId: 'text-1' }
  ])
})

test('buildConversationGroupTimelineItems groups bash read commands with native read tools', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeAssistantTextBlocks: [],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'a.ts',
        startedAt: '2026-03-22T00:00:01.000Z'
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'cat b.ts',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: { command: 'cat b.ts', cwd: '/workspace', stdout: '', stderr: '' }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'head -20 c.ts',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: { command: 'head -20 c.ts', cwd: '/workspace', stdout: '', stderr: '' }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'read-files',
      toolCallIds: ['tool-1', 'tool-2', 'tool-3']
    }
  ])
})

test('buildConversationGroupTimelineItems groups bash search commands with native grep tools', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeAssistantTextBlocks: [],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'grep',
        status: 'completed',
        inputSummary: 'foo',
        startedAt: '2026-03-22T00:00:01.000Z'
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: "rg 'bar'",
        startedAt: '2026-03-22T00:00:02.000Z',
        details: { command: "rg 'bar'", cwd: '/workspace', stdout: '', stderr: '' }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: "find . -name '*.ts'",
        startedAt: '2026-03-22T00:00:03.000Z',
        details: { command: "find . -name '*.ts'", cwd: '/workspace', stdout: '', stderr: '' }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'search-files',
      toolCallIds: ['tool-1', 'tool-2', 'tool-3']
    }
  ])
})

test('buildConversationGroupTimelineItems groups consecutive searchMemory tool calls', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeAssistantTextBlocks: [],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'searchMemory',
        status: 'completed',
        inputSummary: 'preferences',
        startedAt: '2026-03-22T00:00:01.000Z'
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'searchMemory',
        status: 'completed',
        inputSummary: 'decisions',
        startedAt: '2026-03-22T00:00:02.000Z'
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'searchMemory',
        status: 'completed',
        inputSummary: 'workflows',
        startedAt: '2026-03-22T00:00:03.000Z'
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'search-memory',
      toolCallIds: ['tool-1', 'tool-2', 'tool-3']
    }
  ])
})

test('buildConversationGroupTimelineItems keeps bash run commands separate from search tools', () => {
  const items = buildConversationGroupTimelineItems({
    hasMemoryRecall: false,
    replyCount: 1,
    showPreparing: false,
    showGenerating: false,
    activeAssistantTextBlocks: [],
    visibleToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'grep',
        status: 'completed',
        inputSummary: 'foo',
        startedAt: '2026-03-22T00:00:01.000Z'
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'npm test',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: { command: 'npm test', cwd: '/workspace', stdout: '', stderr: '' }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'cargo test',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: { command: 'cargo test', cwd: '/workspace', stdout: '', stderr: '' }
      }
    ]
  })

  // grep (search) breaks from npm/cargo (run), but the two run-commands
  // are consecutive same-group → grouped together.
  assert.deepEqual(items, [
    { kind: 'tool-call', key: 'tool-1', toolCallId: 'tool-1' },
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-2',
      group: 'run-commands',
      toolCallIds: ['tool-2', 'tool-3']
    }
  ])
})
