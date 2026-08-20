import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSendThreadMessageTool,
  type SendThreadMessageToolOutput
} from './sendThreadMessageTool.ts'

test('sendThreadMessage dispatches a hidden steer to the requested conversation', async () => {
  const deliveries: Array<{ targetThreadId: string; message: string }> = []
  const tool = createSendThreadMessageTool({
    sourceThreadId: 'thread-source',
    dispatch: async (input) => {
      deliveries.push(input)
      return { kind: 'active-run-steer-pending', runId: 'run-target' }
    }
  })

  const execute = tool.execute!
  const output = (await execute(
    {
      targetThreadId: 'thread-target',
      message: 'Please verify the migration before I continue.'
    },
    { toolCallId: 'send-thread-message-1', messages: [] }
  )) as SendThreadMessageToolOutput

  assert.deepEqual(deliveries, [
    {
      targetThreadId: 'thread-target',
      message: 'Please verify the migration before I continue.'
    }
  ])
  assert.equal(output.error, undefined)
  const deliveredText = output.content[0]
  assert.ok(deliveredText?.type === 'text', 'expected a text content block')
  assert.equal(deliveredText.text, 'Message delivered to conversation thread-target (run-target).')
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

  const execute = tool.execute!
  const output = (await execute(
    {
      targetThreadId: 'thread-source',
      message: 'This must not be delivered.'
    },
    { toolCallId: 'send-thread-message-2', messages: [] }
  )) as SendThreadMessageToolOutput

  assert.equal(dispatched, false)
  assert.equal(output.error, 'Cannot send a message to the current conversation.')
  const errorText = output.content[0]
  assert.ok(errorText?.type === 'text', 'expected a text content block')
  assert.equal(errorText.text, 'Cannot send a message to the current conversation.')
})
