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

test('edit group counts only mutated files, not absorbed reads', () => {
  const toolCalls: ToolCall[] = [
    {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'completed' as const,
      inputSummary: '/workspace/src/a.ts',
      startedAt: '2026-03-22T00:00:01.000Z',
      details: {
        path: '/workspace/src/a.ts',
        startLine: 1,
        endLine: 75,
        totalLines: 75,
        totalBytes: 2000,
        truncated: false
      }
    },
    {
      id: 'tool-2',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'completed' as const,
      inputSummary: '/workspace/src/b.ts',
      startedAt: '2026-03-22T00:00:02.000Z',
      details: {
        path: '/workspace/src/b.ts',
        startLine: 1,
        endLine: 260,
        totalLines: 431,
        totalBytes: 8000,
        truncated: true
      }
    },
    {
      id: 'tool-3',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'completed' as const,
      inputSummary: '/workspace/src/c.ts',
      startedAt: '2026-03-22T00:00:03.000Z',
      details: {
        path: '/workspace/src/c.ts',
        startLine: 1,
        endLine: 116,
        totalLines: 116,
        totalBytes: 3000,
        truncated: false
      }
    },
    {
      id: 'tool-4',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'completed' as const,
      inputSummary: '/workspace/src/d.ts',
      startedAt: '2026-03-22T00:00:04.000Z',
      details: {
        path: '/workspace/src/d.ts',
        startLine: 1,
        endLine: 57,
        totalLines: 57,
        totalBytes: 1500,
        truncated: false
      }
    },
    {
      id: 'tool-5',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'edit' as const,
      status: 'completed' as const,
      inputSummary: '/workspace/src/d.ts',
      startedAt: '2026-03-22T00:00:05.000Z',
      details: {
        path: '/workspace/src/d.ts',
        mode: 'inline' as const,
        replacements: 1,
        firstChangedLine: 47
      }
    }
  ]

  assert.equal(getToolCallGroupCount('edit-files', toolCalls), 1)
  assert.deepEqual(getToolCallGroupFilePaths('edit-files', toolCalls), ['/workspace/src/d.ts'])
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

test('mixed failed reads and bash commands preserve inspect-workspace count', () => {
  const toolCalls: ToolCall[] = [
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
      toolName: 'read' as const,
      status: 'failed' as const,
      inputSummary: '/workspace/src/missing.ts',
      outputSummary: 'ENOENT: no such file or directory',
      startedAt: '2026-03-22T00:00:02.000Z',
      finishedAt: '2026-03-22T00:00:02.100Z'
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

  assert.equal(getToolCallGroupDisplayGroup('read-files', toolCalls), 'inspect-workspace')
  assert.equal(getToolCallGroupCount('read-files', toolCalls), 2)
  assert.equal(
    getToolCallGroupLabel('inspect-workspace', 2, true),
    'Inspected workspace · 2 commands'
  )
})

test('all-failed reads stay as read-files instead of becoming inspect-workspace', () => {
  const toolCalls: ToolCall[] = [
    {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'failed' as const,
      inputSummary: '/workspace/src/missing-a.ts',
      outputSummary: 'ENOENT: no such file or directory',
      startedAt: '2026-03-22T00:00:01.000Z',
      finishedAt: '2026-03-22T00:00:01.100Z'
    },
    {
      id: 'tool-2',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'failed' as const,
      inputSummary: '/workspace/src/missing-b.ts',
      outputSummary: 'ENOENT: no such file or directory',
      startedAt: '2026-03-22T00:00:02.000Z',
      finishedAt: '2026-03-22T00:00:02.100Z'
    },
    {
      id: 'tool-3',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read' as const,
      status: 'failed' as const,
      inputSummary: '/workspace/src/missing-c.ts',
      outputSummary: 'ENOENT: no such file or directory',
      startedAt: '2026-03-22T00:00:03.000Z',
      finishedAt: '2026-03-22T00:00:03.100Z'
    }
  ]

  assert.equal(getToolCallGroupDisplayGroup('read-files', toolCalls), 'read-files')
  assert.equal(getToolCallGroupCount('read-files', toolCalls), 0)
  assert.equal(getToolCallGroupLabel('read-files', 0, true), 'Read files')
})

test('failed commands still count in inspect-workspace', () => {
  const toolCalls: ToolCall[] = [
    {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'bash' as const,
      status: 'failed' as const,
      inputSummary: 'git status',
      startedAt: '2026-03-22T00:00:01.000Z',
      finishedAt: '2026-03-22T00:00:01.100Z'
    },
    {
      id: 'tool-2',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'bash' as const,
      status: 'completed' as const,
      inputSummary: 'git diff',
      startedAt: '2026-03-22T00:00:02.000Z',
      details: { command: 'git diff', cwd: '/workspace', stdout: '', stderr: '', exitCode: 0 }
    }
  ]

  assert.equal(getToolCallGroupDisplayGroup('read-files', toolCalls), 'inspect-workspace')
  assert.equal(getToolCallGroupCount('read-files', toolCalls), 2)
})

test('failed grep and glob still count in search-files', () => {
  const toolCalls: ToolCall[] = [
    {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'grep' as const,
      status: 'failed' as const,
      inputSummary: 'nonexistent_pattern',
      startedAt: '2026-03-22T00:00:01.000Z',
      finishedAt: '2026-03-22T00:00:01.100Z'
    },
    {
      id: 'tool-2',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'glob' as const,
      status: 'completed' as const,
      inputSummary: '**/*.ts',
      startedAt: '2026-03-22T00:00:02.000Z'
    },
    {
      id: 'tool-3',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'grep' as const,
      status: 'failed' as const,
      inputSummary: 'another_missing',
      startedAt: '2026-03-22T00:00:03.000Z',
      finishedAt: '2026-03-22T00:00:03.100Z'
    }
  ]

  assert.equal(getToolCallGroupCount('search-files', toolCalls), 3)
  assert.equal(getToolCallGroupLabel('search-files', 3, true), 'Searched 3 patterns')
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
