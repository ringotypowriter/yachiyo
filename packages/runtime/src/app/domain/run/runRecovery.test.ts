import test from 'node:test'
import assert from 'node:assert/strict'

import { textContent } from '../../../tools/agentTools/shared.ts'
import { appendRecoveryToolResult, buildRecoveryResponseMessages } from './runRecovery.ts'

test('appendRecoveryToolResult stores text-only content as plain text model output', () => {
  const responseMessages = []

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
