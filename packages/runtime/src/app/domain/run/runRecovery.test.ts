import test from 'node:test'
import assert from 'node:assert/strict'

import { textContent } from '../../../tools/agentTools/shared.ts'
import {
  appendRecoveryToolResult,
  buildRecoveryResponseMessages,
  type RecoveryResponseMessage
} from './runRecovery.ts'

test('appendRecoveryToolResult stores text-only content as plain text model output', () => {
  const responseMessages: RecoveryResponseMessage[] = []

  appendRecoveryToolResult(responseMessages, {
    toolCallId: 'tc-grep',
    toolName: 'grep',
    output: {
      content: textContent('src/example.ts:12: const needle = true'),
      details: {
        backend: 'rg',
        pattern: 'needle',
        path: '/workspace',
        resultCount: 1,
        truncated: false,
        matches: []
      },
      metadata: {}
    }
  })

  assert.deepStrictEqual(responseMessages, [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-grep',
          toolName: 'grep',
          output: {
            type: 'text',
            value: 'src/example.ts:12: const needle = true'
          }
        }
      ]
    }
  ])
})

test('buildRecoveryResponseMessages reconstructs pyRepl input and reset state', () => {
  const responseMessages = buildRecoveryResponseMessages({
    checkpoint: { content: '' },
    toolCalls: [
      {
        id: 'tc-python',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'pyRepl',
        status: 'completed',
        inputSummary: 'inspect state',
        details: {
          code: 'value + 1',
          title: 'inspect state',
          cwd: 'analysis',
          result: '42',
          contextReset: true
        },
        startedAt: '2026-05-18T00:00:00.000Z',
        finishedAt: '2026-05-18T00:00:01.000Z'
      }
    ]
  })

  assert.deepStrictEqual(responseMessages?.[0], {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'tc-python',
        toolName: 'pyRepl',
        input: {
          code: 'value + 1',
          title: 'inspect state',
          cwd: 'analysis',
          reset: true
        }
      }
    ]
  })
})

test('recovery uses the original call input instead of reconstructing a lossy summary', () => {
  const longEdit = 'new text\n'.repeat(2_000)
  const calls = [
    {
      toolName: 'sendThreadMessage',
      input: { targetThreadId: 'thread-2', message: 'Full message' }
    },
    { toolName: 'remember', input: { note: 'Full source-linked note', sources: ['message-1'] } },
    { toolName: 'useSentinel', input: { action: 'set', goal: 'Check build', intervalMinutes: 5 } },
    { toolName: 'edit', input: { path: 'a.ts', mode: 'inline', oldText: 'a', newText: longEdit } }
  ]

  for (const { toolName, input } of calls) {
    const responseMessages = buildRecoveryResponseMessages({
      checkpoint: { content: '' },
      toolCalls: [
        {
          id: `tc-${toolName}`,
          threadId: 'thread-1',
          toolName,
          status: 'completed',
          inputSummary: toolName,
          rawInput: input,
          startedAt: '2026-09-25T00:00:00.000Z',
          finishedAt: '2026-09-25T00:00:01.000Z'
        }
      ]
    }) as RecoveryResponseMessage[] | undefined
    assert.deepEqual(responseMessages?.[0]?.content[0], {
      type: 'tool-call',
      toolCallId: `tc-${toolName}`,
      toolName,
      input
    })
  }
})
