import test from 'node:test'
import assert from 'node:assert/strict'

import { textContent } from '../../../tools/agentTools/shared.ts'
import { appendRecoveryToolResult } from './runRecovery.ts'

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
