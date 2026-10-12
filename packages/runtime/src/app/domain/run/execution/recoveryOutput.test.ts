import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import type { ToolCallRecord } from '@yachiyo/shared/protocol'
import { rewindRecoveryOutput } from './recoveryOutput.ts'

const checkpoint: RunRecoveryCheckpoint = {
  runId: 'run-1',
  threadId: 'thread-1',
  requestMessageId: 'request-1',
  assistantMessageId: 'answer-1',
  enabledTools: [],
  content: 'An interrupted answer',
  reasoning: 'Unfinished reasoning',
  runTrigger: 'local',
  updateHeadOnComplete: true,
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
  recoveryAttempts: 1
}

const tool: ToolCallRecord = {
  id: 'tool-1',
  runId: checkpoint.runId,
  threadId: checkpoint.threadId,
  toolName: 'read',
  status: 'completed',
  inputSummary: 'file.txt',
  outputSummary: 'The file contents',
  startedAt: checkpoint.createdAt,
  finishedAt: checkpoint.updatedAt
}

test('recovery discards an interrupted text-only generation, including reasoning', () => {
  const recovered = rewindRecoveryOutput(checkpoint, [])
  assert.equal(recovered.content, '')
  assert.equal(recovered.reasoning, undefined)
  assert.deepEqual(recovered.textBlocks, [])
  assert.deepEqual(recovered.responseMessages, [])
  assert.equal(recovered.assistantMessageId, checkpoint.assistantMessageId)
  assert.equal(checkpoint.content, 'An interrupted answer')
})

test('legacy checkpoints without structured boundaries regenerate text while retaining tool results', () => {
  const recovered = rewindRecoveryOutput(checkpoint, [tool])
  assert.equal(recovered.content, '')
  assert.equal(recovered.reasoning, undefined)
  assert.match(JSON.stringify(recovered.responseMessages), /The file contents/)
  assert.doesNotMatch(JSON.stringify(recovered.responseMessages), /interrupted answer/)
})

for (const status of ['completed', 'failed'] as const) {
  test(`recovery keeps ${status} tool work but removes the following generation`, () => {
    const original: RunRecoveryCheckpoint = {
      ...checkpoint,
      content: 'Before tool. Interrupted answer',
      reasoning: 'Before tool reasoning.After tool reasoning.',
      textBlocks: [
        { id: 'before', content: 'Before tool. ', createdAt: checkpoint.createdAt },
        { id: 'after', content: 'Interrupted answer', createdAt: checkpoint.updatedAt }
      ],
      responseMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Before tool reasoning.' },
            { type: 'text', text: 'Before tool. ' },
            { type: 'tool-call', toolCallId: tool.id, toolName: tool.toolName, input: {} }
          ]
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: tool.id, toolName: tool.toolName, output: {} }
          ]
        },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'After tool reasoning.' },
            { type: 'text', text: 'Interrupted answer' }
          ]
        }
      ]
    }
    const originalCopy = structuredClone(original)
    const recovered = rewindRecoveryOutput(original, [{ ...tool, status }])
    assert.equal(recovered.content, 'Before tool. ')
    assert.equal(recovered.reasoning, 'Before tool reasoning.')
    assert.deepEqual(recovered.textBlocks, [original.textBlocks![0]])
    assert.equal(recovered.responseMessages?.length, 2)
    assert.match(JSON.stringify(recovered.responseMessages), /tool-1/)
    assert.doesNotMatch(JSON.stringify(recovered.responseMessages), /Interrupted answer/)
    assert.deepEqual(rewindRecoveryOutput(recovered, [{ ...tool, status }]), recovered)
    assert.deepEqual(original, originalCopy)
  })
}

test('recovery removes trailing text even when a provider keeps it in the tool-call message', () => {
  const recovered = rewindRecoveryOutput(
    {
      ...checkpoint,
      content: 'Before. Partial',
      textBlocks: [{ id: 'one', content: 'Before. Partial', createdAt: checkpoint.createdAt }],
      responseMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Before. ' },
            { type: 'tool-call', toolCallId: tool.id, toolName: tool.toolName, input: {} },
            { type: 'text', text: 'Partial' }
          ]
        }
      ]
    },
    [tool]
  )
  assert.equal(recovered.content, 'Before. ')
  assert.equal(recovered.textBlocks?.[0].content, 'Before. ')
  assert.equal(recovered.responseMessages?.length, 2)
})

test('structured legacy checkpoints rebuild missing display blocks for retained commentary', () => {
  const recovered = rewindRecoveryOutput(
    {
      ...checkpoint,
      content: 'Before tool. Interrupted answer',
      responseMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Before tool. ' },
            { type: 'tool-call', toolCallId: tool.id, toolName: tool.toolName, input: {} }
          ]
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Interrupted answer' }] }
      ]
    },
    [tool]
  )
  assert.deepEqual(
    recovered.textBlocks?.map((block) => block.content),
    ['Before tool. ']
  )
  assert.deepEqual(rewindRecoveryOutput(recovered, [tool]), recovered)
})
