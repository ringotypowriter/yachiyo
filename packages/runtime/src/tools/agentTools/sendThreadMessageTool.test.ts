import assert from 'node:assert/strict'
import test from 'node:test'

import { createSendThreadMessageTool } from './sendThreadMessageTool.ts'

test('sendThreadMessage dispatches a hidden steer to the requested conversation', async () => {
  const deliveries: Array<{ targetThreadId: string; message: string }> = []
  const tool = createSendThreadMessageTool({
    sourceThreadId: 'thread-source',
    dispatch: async (input) => {
      deliveries.push(input)
      return { kind: 'active-run-steer-pending', runId: 'run-target' }
    }
  })

  const output = await tool.execute({
    targetThreadId: 'thread-target',
    message: 'Please verify the migration before I continue.'
  })

  assert.deepEqual(deliveries, [
    {
      targetThreadId: 'thread-target',
      message: 'Please verify the migration before I continue.'
    }
  ])
  assert.equal(output.error, undefined)
  assert.equal(
    output.content[0]?.text,
    'Message delivered to conversation thread-target (run-target).'
  )
})

test('sendThreadMessage refuses to send a message to its own conversation', async () => {
  let dispatched = false
  const tool = createSendThreadMessageTool({
    sourceThreadId: 'thread-source',
    dispatch: async () => {
      dispatched = true
      return { kind: 'run-started', runId: 'run-source' }
    }
  })

  const output = await tool.execute({
    targetThreadId: 'thread-source',
    message: 'This must not be delivered.'
  })

  assert.equal(dispatched, false)
  assert.equal(output.error, 'Cannot send a message to the current conversation.')
  assert.equal(output.content[0]?.text, 'Cannot send a message to the current conversation.')
})
