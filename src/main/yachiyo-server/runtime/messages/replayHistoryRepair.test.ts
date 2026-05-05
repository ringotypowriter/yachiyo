import assert from 'node:assert/strict'
import test from 'node:test'

import { repairReplayHistoryMessages } from './replayHistoryRepair.ts'

test('repairReplayHistoryMessages queues a persistence callback when stored responseMessages are repaired', () => {
  const persistedRepairs: Array<{ messageId: string; responseMessages: unknown[] }> = []
  const history = [
    {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: 'Done.',
      responseMessages: [
        {
          role: 'assistant' as const,
          content: [{ type: 'tool-call', toolName: 'glob', input: { pattern: '*.ts' } }]
        },
        {
          role: 'tool' as const,
          content: [{ type: 'tool-result', toolCallId: 'glob:1', toolName: 'glob', output: 'a.ts' }]
        }
      ]
    }
  ]

  const repaired = repairReplayHistoryMessages({
    messages: history,
    persistRepairedResponseMessages: (repair) => {
      persistedRepairs.push(repair)
    }
  })

  assert.notEqual(repaired, history)
  assert.equal(persistedRepairs.length, 1)
  assert.equal(persistedRepairs[0]?.messageId, 'assistant-1')

  const repairedResponseMessages = repaired[0]?.responseMessages as Array<{
    role: string
    content: Array<{ type?: string; toolCallId?: string; toolName?: string }>
  }>
  assert.equal(
    repairedResponseMessages[0]?.content[0]?.toolCallId,
    'glob:1',
    'replayed history should use the repaired toolCallId immediately'
  )

  const persistedResponseMessages = persistedRepairs[0]?.responseMessages as Array<{
    role: string
    content: Array<{ type?: string; toolCallId?: string; toolName?: string }>
  }>
  assert.equal(
    persistedResponseMessages[0]?.content[0]?.toolCallId,
    'glob:1',
    'background persistence should receive the repaired payload'
  )
})

test('repairReplayHistoryMessages does not queue persistence when stored responseMessages are already balanced', () => {
  const history = [
    {
      id: 'assistant-1',
      role: 'assistant' as const,
      content: 'Done.',
      responseMessages: [
        {
          role: 'assistant' as const,
          content: [{ type: 'tool-call', toolCallId: 'glob:1', toolName: 'glob', input: {} }]
        },
        {
          role: 'tool' as const,
          content: [{ type: 'tool-result', toolCallId: 'glob:1', toolName: 'glob', output: 'a.ts' }]
        }
      ]
    }
  ]

  let persistCalled = false
  const repaired = repairReplayHistoryMessages({
    messages: history,
    persistRepairedResponseMessages: () => {
      persistCalled = true
    }
  })

  assert.equal(repaired, history)
  assert.equal(persistCalled, false)
})
