import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolCall } from '@renderer/app/types'
import {
  buildConversationGroupTimelineItems,
  getToolCallGroupCount,
  getToolCallGroupDisplayGroup,
  getToolCallGroupFilePaths,
  getToolCallGroupLabel
} from './messageTimelineLayout.ts'

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

test('buildConversationGroupTimelineItems treats read and edit calls on the same file as editing', () => {
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
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          path: '/workspace/src/file.ts',
          startLine: 1,
          endLine: 40,
          totalLines: 100,
          totalBytes: 2000,
          truncated: true
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/src/file.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 20
        }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: {
          path: '/workspace/src/file.ts',
          startLine: 1,
          endLine: 40,
          totalLines: 100,
          totalBytes: 2000,
          truncated: true
        }
      },
      {
        id: 'tool-4',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:04.000Z',
        details: {
          path: '/workspace/src/file.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 60
        }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'edit-files',
      toolCallIds: ['tool-1', 'tool-2', 'tool-3', 'tool-4']
    }
  ])
})

test('buildConversationGroupTimelineItems treats grep and edit calls as editing', () => {
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
        inputSummary: 'fraction.*percent',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          backend: 'rg',
          pattern: 'fraction.*percent',
          path: '/workspace',
          resultCount: 3,
          truncated: false,
          matches: [
            {
              path: '/workspace/src/tools/sympy-tools.ts',
              line: 106,
              text: 'fraction percent'
            }
          ]
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/tools/sympy-tools.ts',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/src/tools/sympy-tools.ts',
          mode: 'inline',
          replacements: 3,
          firstChangedLine: 106
        }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'grep',
        status: 'completed',
        inputSummary: 'fraction.*percent',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: {
          backend: 'rg',
          pattern: 'fraction.*percent',
          path: '/workspace',
          resultCount: 1,
          truncated: false,
          matches: [
            {
              path: '/workspace/src/tools/engine_cli.py',
              line: 74,
              text: 'fraction percent'
            }
          ]
        }
      },
      {
        id: 'tool-4',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/tools/engine_cli.py',
        startedAt: '2026-03-22T00:00:04.000Z',
        details: {
          path: '/workspace/src/tools/engine_cli.py',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 74
        }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'edit-files',
      toolCallIds: ['tool-1', 'tool-2', 'tool-3', 'tool-4']
    }
  ])
})

test('buildConversationGroupTimelineItems keeps editing groups alive after an intervening grep', () => {
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
        inputSummary: '/workspace/src/tools/engine_cli.py',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          path: '/workspace/src/tools/engine_cli.py',
          startLine: 125,
          endLine: 184,
          totalLines: 400,
          totalBytes: 9000,
          truncated: true
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/tools/engine_cli.py',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/src/tools/engine_cli.py',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 64
        }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'grep',
        status: 'completed',
        inputSummary: 'if __name__|argparse|args|dispatch',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: {
          backend: 'rg',
          pattern: 'if __name__|argparse|args|dispatch',
          path: '/workspace',
          resultCount: 7,
          truncated: false,
          matches: []
        }
      },
      {
        id: 'tool-4',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: '/workspace/src/tools/engine_cli.py',
        startedAt: '2026-03-22T00:00:04.000Z',
        details: {
          path: '/workspace/src/tools/engine_cli.py',
          startLine: 310,
          endLine: 377,
          totalLines: 400,
          totalBytes: 9000,
          truncated: false
        }
      },
      {
        id: 'tool-5',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/tools/engine_cli.py',
        startedAt: '2026-03-22T00:00:05.000Z',
        details: {
          path: '/workspace/src/tools/engine_cli.py',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 316
        }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'edit-files',
      toolCallIds: ['tool-1', 'tool-2', 'tool-3', 'tool-4', 'tool-5']
    }
  ])
})

test('buildConversationGroupTimelineItems can return to an earlier file after grep in a multi-file edit group', () => {
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
        inputSummary: '/workspace/uncertainty-agent/src/pipeline.ts',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          path: '/workspace/uncertainty-agent/src/pipeline.ts',
          startLine: 299,
          endLine: 313,
          totalLines: 500,
          totalBytes: 12000,
          truncated: true
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/uncertainty-agent/src/pipeline.ts',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/uncertainty-agent/src/pipeline.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 298
        }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/uncertainty-agent/src/main.ts',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: {
          path: '/workspace/uncertainty-agent/src/main.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 196
        }
      },
      {
        id: 'tool-4',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'grep',
        status: 'completed',
        inputSummary: 'buildPrompt|extraPrompt.*system',
        startedAt: '2026-03-22T00:00:04.000Z',
        details: {
          backend: 'rg',
          pattern: 'buildPrompt|extraPrompt.*system',
          path: '/workspace',
          resultCount: 1,
          truncated: false,
          matches: []
        }
      },
      {
        id: 'tool-5',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: '/workspace/uncertainty-agent/src/pipeline.ts',
        startedAt: '2026-03-22T00:00:05.000Z',
        details: {
          path: '/workspace/uncertainty-agent/src/pipeline.ts',
          startLine: 131,
          endLine: 150,
          totalLines: 500,
          totalBytes: 12000,
          truncated: true
        }
      },
      {
        id: 'tool-6',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/uncertainty-agent/src/pipeline.ts',
        startedAt: '2026-03-22T00:00:06.000Z',
        details: {
          path: '/workspace/uncertainty-agent/src/pipeline.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 142
        }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'edit-files',
      toolCallIds: ['tool-1', 'tool-2', 'tool-3', 'tool-4', 'tool-5', 'tool-6']
    }
  ])
})

test('buildConversationGroupTimelineItems can expand an editing group to a newly read file', () => {
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
        inputSummary: '/workspace/src/tools/engine_cli.py',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          path: '/workspace/src/tools/engine_cli.py',
          startLine: 310,
          endLine: 377,
          totalLines: 400,
          totalBytes: 9000,
          truncated: false
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/tools/engine_cli.py',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/src/tools/engine_cli.py',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 316
        }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: '/workspace/uncertainty-agent/src/tools/sympy-tools.ts',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: {
          path: '/workspace/uncertainty-agent/src/tools/sympy-tools.ts',
          startLine: 95,
          endLine: 174,
          totalLines: 500,
          totalBytes: 12000,
          truncated: true
        }
      },
      {
        id: 'tool-4',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/uncertainty-agent/src/tools/sympy-tools.ts',
        startedAt: '2026-03-22T00:00:04.000Z',
        details: {
          path: '/workspace/uncertainty-agent/src/tools/sympy-tools.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 101
        }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'edit-files',
      toolCallIds: ['tool-1', 'tool-2', 'tool-3', 'tool-4']
    }
  ])
})

test('buildConversationGroupTimelineItems does not count unrelated reads as edited files', () => {
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
        inputSummary: '/workspace/src/a.ts',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          path: '/workspace/src/a.ts',
          startLine: 1,
          endLine: 20,
          totalLines: 100,
          totalBytes: 2000,
          truncated: false
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/a.ts',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/src/a.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 12
        }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: '/workspace/src/b.ts',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: {
          path: '/workspace/src/b.ts',
          startLine: 1,
          endLine: 20,
          totalLines: 100,
          totalBytes: 2000,
          truncated: false
        }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'edit-files',
      toolCallIds: ['tool-1', 'tool-2']
    },
    { kind: 'tool-call', key: 'tool-3', toolCallId: 'tool-3' }
  ])
})

test('getToolCallGroupCount counts unique files for editing groups', () => {
  assert.equal(
    getToolCallGroupCount('edit-files', [
      {
        id: 'tool-0',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'grep',
        status: 'completed',
        inputSummary: 'needle',
        startedAt: '2026-03-22T00:00:00.000Z',
        details: {
          backend: 'rg',
          pattern: 'needle',
          path: '/workspace',
          resultCount: 1,
          truncated: false,
          matches: []
        }
      },
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          path: '/workspace/src/file.ts',
          startLine: 1,
          endLine: 40,
          totalLines: 100,
          totalBytes: 2000,
          truncated: true
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/src/file.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 20
        }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/other.ts',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: {
          path: '/workspace/src/other.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 12
        }
      }
    ]),
    2
  )
})

test('getToolCallGroupCount ignores preparing file tool placeholders', () => {
  const toolCalls = [
    {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'edit' as const,
      status: 'completed' as const,
      inputSummary: '/workspace/src/file.ts',
      startedAt: '2026-03-22T00:00:01.000Z',
      details: {
        path: '/workspace/src/file.ts',
        mode: 'inline' as const,
        replacements: 1,
        firstChangedLine: 20
      }
    },
    {
      id: 'tool-2',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'edit' as const,
      status: 'preparing' as const,
      inputSummary: '/workspace/src/temporary-summary.ts',
      startedAt: '2026-03-22T00:00:02.000Z'
    }
  ]

  assert.equal(getToolCallGroupCount('edit-files', toolCalls), 1)
  assert.deepEqual(getToolCallGroupFilePaths('edit-files', toolCalls), ['/workspace/src/file.ts'])
})

test('getToolCallGroupLabel omits zero counts for file groups without confirmed targets', () => {
  assert.equal(getToolCallGroupLabel('read-files', 0), 'Reading files')
  assert.equal(getToolCallGroupLabel('edit-files', 0), 'Editing files')
  assert.equal(getToolCallGroupLabel('write-files', 0), 'Writing files')
})

test('getToolCallGroupFilePaths returns up to five file targets in a file group', () => {
  assert.deepEqual(
    getToolCallGroupFilePaths('edit-files', [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          path: '/workspace/src/file.ts',
          startLine: 1,
          endLine: 40,
          totalLines: 100,
          totalBytes: 2000,
          truncated: true
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/src/file.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 20
        }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/other.ts',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: {
          path: '/workspace/src/other.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 12
        }
      },
      {
        id: 'tool-4',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/third.ts',
        startedAt: '2026-03-22T00:00:04.000Z',
        details: {
          path: '/workspace/src/third.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 18
        }
      },
      {
        id: 'tool-5',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/fourth.ts',
        startedAt: '2026-03-22T00:00:05.000Z',
        details: {
          path: '/workspace/src/fourth.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 24
        }
      },
      {
        id: 'tool-6',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/fifth.ts',
        startedAt: '2026-03-22T00:00:06.000Z',
        details: {
          path: '/workspace/src/fifth.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 30
        }
      }
    ]),
    [
      '/workspace/src/file.ts',
      '/workspace/src/other.ts',
      '/workspace/src/third.ts',
      '/workspace/src/fourth.ts',
      '/workspace/src/fifth.ts'
    ]
  )
})

test('getToolCallGroupFilePaths omits groups with more than five file targets', () => {
  assert.deepEqual(
    getToolCallGroupFilePaths('edit-files', [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          path: '/workspace/src/file.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 20
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/other.ts',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/src/other.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 12
        }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/third.ts',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: {
          path: '/workspace/src/third.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 18
        }
      },
      {
        id: 'tool-4',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/fourth.ts',
        startedAt: '2026-03-22T00:00:04.000Z',
        details: {
          path: '/workspace/src/fourth.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 24
        }
      },
      {
        id: 'tool-5',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/fifth.ts',
        startedAt: '2026-03-22T00:00:05.000Z',
        details: {
          path: '/workspace/src/fifth.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 30
        }
      },
      {
        id: 'tool-6',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'edit',
        status: 'completed',
        inputSummary: '/workspace/src/sixth.ts',
        startedAt: '2026-03-22T00:00:06.000Z',
        details: {
          path: '/workspace/src/sixth.ts',
          mode: 'inline',
          replacements: 1,
          firstChangedLine: 36
        }
      }
    ]),
    []
  )
})

test('getToolCallGroupCount counts unique files for reading groups', () => {
  assert.equal(
    getToolCallGroupCount('read-files', [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          path: '/workspace/src/file.ts',
          startLine: 1,
          endLine: 40,
          totalLines: 100,
          totalBytes: 2000,
          truncated: true
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/src/file.ts',
          startLine: 41,
          endLine: 80,
          totalLines: 100,
          totalBytes: 2000,
          truncated: true
        }
      }
    ]),
    1
  )
})

test('tool call group summaries ignore failed file targets', () => {
  const toolCalls: ToolCall[] = [
    {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'completed' as const,
      inputSummary: '/workspace/uncertainty-agent/src/contract.ts',
      startedAt: '2026-03-22T00:00:01.000Z',
      details: {
        path: '/workspace/uncertainty-agent/src/contract.ts',
        startLine: 1,
        endLine: 80,
        totalLines: 100,
        totalBytes: 2000,
        truncated: false
      }
    },
    {
      id: 'tool-2',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'failed' as const,
      inputSummary: '/workspace/prompts.ts',
      outputSummary: 'No such file or directory',
      startedAt: '2026-03-22T00:00:02.000Z',
      finishedAt: '2026-03-22T00:00:02.100Z'
    },
    {
      id: 'tool-3',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'completed' as const,
      inputSummary: '/workspace/uncertainty-agent/src/agents/prompts.ts',
      startedAt: '2026-03-22T00:00:03.000Z',
      details: {
        path: '/workspace/uncertainty-agent/src/agents/prompts.ts',
        startLine: 1,
        endLine: 80,
        totalLines: 100,
        totalBytes: 2000,
        truncated: false
      }
    },
    {
      id: 'tool-4',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'completed' as const,
      inputSummary: '/workspace/uncertainty-agent/src/stages.ts',
      startedAt: '2026-03-22T00:00:04.000Z',
      details: {
        path: '/workspace/uncertainty-agent/src/stages.ts',
        startLine: 1,
        endLine: 80,
        totalLines: 100,
        totalBytes: 2000,
        truncated: false
      }
    }
  ]

  assert.equal(getToolCallGroupCount('read-files', toolCalls), 3)
  assert.deepEqual(getToolCallGroupFilePaths('read-files', toolCalls), [
    '/workspace/uncertainty-agent/src/contract.ts',
    '/workspace/uncertainty-agent/src/agents/prompts.ts',
    '/workspace/uncertainty-agent/src/stages.ts'
  ])
})

test('getToolCallGroupCount counts unique files for writing groups', () => {
  assert.equal(
    getToolCallGroupCount('write-files', [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'write',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: {
          path: '/workspace/src/file.ts',
          bytesWritten: 120,
          created: true,
          overwritten: false
        }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'write',
        status: 'completed',
        inputSummary: '/workspace/src/file.ts',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: {
          path: '/workspace/src/file.ts',
          bytesWritten: 180,
          created: false,
          overwritten: true
        }
      },
      {
        id: 'tool-3',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'write',
        status: 'completed',
        inputSummary: '/workspace/src/other.ts',
        startedAt: '2026-03-22T00:00:03.000Z',
        details: {
          path: '/workspace/src/other.ts',
          bytesWritten: 90,
          created: true,
          overwritten: false
        }
      }
    ]),
    2
  )
})

test('getToolCallGroupLabel describes file searches as patterns', () => {
  assert.equal(getToolCallGroupLabel('search-files', 1), 'Searching 1 pattern')
  assert.equal(getToolCallGroupLabel('search-files', 2, true), 'Searched 2 patterns')
})

test('getToolCallGroupLabel describes pathless read groups as workspace inspection', () => {
  const toolCalls = [
    {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'bash' as const,
      status: 'completed' as const,
      inputSummary: 'git status',
      startedAt: '2026-03-22T00:00:01.000Z',
      details: { command: 'git status', cwd: '/workspace', stdout: '', stderr: '', exitCode: 0 }
    },
    {
      id: 'tool-2',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'bash' as const,
      status: 'completed' as const,
      inputSummary: 'git diff --stat',
      startedAt: '2026-03-22T00:00:02.000Z',
      details: {
        command: 'git diff --stat',
        cwd: '/workspace',
        stdout: '',
        stderr: '',
        exitCode: 0
      }
    },
    {
      id: 'tool-3',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'bash' as const,
      status: 'completed' as const,
      inputSummary: 'git diff',
      startedAt: '2026-03-22T00:00:03.000Z',
      details: { command: 'git diff', cwd: '/workspace', stdout: '', stderr: '', exitCode: 0 }
    }
  ]

  const displayGroup = getToolCallGroupDisplayGroup('read-files', toolCalls)

  assert.equal(displayGroup, 'inspect-workspace')
  assert.equal(getToolCallGroupCount('read-files', toolCalls), 3)
  assert.equal(getToolCallGroupLabel(displayGroup, 3, true), 'Inspected workspace · 3 commands')
})

test('getToolCallGroupLabel describes jsRepl groups as JavaScript snippets', () => {
  assert.equal(getToolCallGroupLabel('evaluate-code', 1), 'Evaluating JavaScript')
  assert.equal(getToolCallGroupLabel('evaluate-code', 3, true), 'Evaluated JavaScript · 3 snippets')
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

test('buildConversationGroupTimelineItems groups consecutive jsRepl tool calls', () => {
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
        toolName: 'jsRepl',
        status: 'completed',
        inputSummary: 'const a = 1',
        startedAt: '2026-03-22T00:00:01.000Z',
        details: { code: 'const a = 1', consoleOutput: '' }
      },
      {
        id: 'tool-2',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'jsRepl',
        status: 'completed',
        inputSummary: 'a + 1',
        startedAt: '2026-03-22T00:00:02.000Z',
        details: { code: 'a + 1', result: '2' }
      }
    ]
  })

  assert.deepEqual(items, [
    {
      kind: 'tool-call-group',
      key: 'tool-group:tool-1',
      group: 'evaluate-code',
      toolCallIds: ['tool-1', 'tool-2']
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
