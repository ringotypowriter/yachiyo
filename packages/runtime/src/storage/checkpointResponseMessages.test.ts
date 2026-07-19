import assert from 'node:assert/strict'
import test from 'node:test'

import { parseResponseMessages, serializeCheckpointResponseMessages } from './storage.ts'

function sampleTranscript(): Array<Record<string, unknown>> {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me read the file' },
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'read', input: { path: '/tmp/a.ts' } }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'read',
          output: { type: 'text', value: 'file content' }
        }
      ]
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'streaming tail' }]
    }
  ]
}

test('serializeCheckpointResponseMessages returns null for undefined and empty', () => {
  assert.equal(serializeCheckpointResponseMessages(undefined), null)
  assert.equal(serializeCheckpointResponseMessages([]), null)
})

test('serializeCheckpointResponseMessages matches plain JSON.stringify output', () => {
  const messages = sampleTranscript()
  assert.equal(serializeCheckpointResponseMessages(messages), JSON.stringify(messages))
})

test('serializeCheckpointResponseMessages round-trips through parseResponseMessages', () => {
  const messages = sampleTranscript()
  assert.deepEqual(parseResponseMessages(serializeCheckpointResponseMessages(messages)), messages)
})

test('serializeCheckpointResponseMessages reflects in-place mutation of the last message', () => {
  const messages = sampleTranscript()
  serializeCheckpointResponseMessages(messages)

  const lastMessage = messages.at(-1) as { content: Array<{ type: string; text: string }> }
  lastMessage.content[0]!.text += ' plus more streamed text'

  assert.equal(serializeCheckpointResponseMessages(messages), JSON.stringify(messages))
})

test('serializeCheckpointResponseMessages serializes frozen prefix messages only once', () => {
  const messages = sampleTranscript()
  let prefixSerializations = 0
  const spied = messages[0] as Record<string, unknown>
  spied.toJSON = function (): unknown {
    prefixSerializations += 1
    return { role: this.role, content: this.content }
  }
  serializeCheckpointResponseMessages(messages)
  serializeCheckpointResponseMessages(messages)
  const third = serializeCheckpointResponseMessages(messages)

  assert.equal(prefixSerializations, 1)
  assert.equal(third, JSON.stringify(messages))
})

test('serializeCheckpointResponseMessages re-serializes the tail message until it is frozen', () => {
  const messages = sampleTranscript()
  let tailSerializations = 0
  const spied = messages.at(-1) as Record<string, unknown>
  spied.toJSON = function (): unknown {
    tailSerializations += 1
    return { role: this.role, content: this.content }
  }

  serializeCheckpointResponseMessages(messages)
  serializeCheckpointResponseMessages(messages)
  assert.equal(tailSerializations, 2)

  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'new tail' }] })
  serializeCheckpointResponseMessages(messages)
  serializeCheckpointResponseMessages(messages)
  assert.equal(tailSerializations, 3)
})

test('serializeCheckpointResponseMessages handles fresh object graphs after a rebuild', () => {
  const before = sampleTranscript()
  serializeCheckpointResponseMessages(before)

  const rebuilt = sampleTranscript()
  assert.equal(serializeCheckpointResponseMessages(rebuilt), JSON.stringify(rebuilt))
})
