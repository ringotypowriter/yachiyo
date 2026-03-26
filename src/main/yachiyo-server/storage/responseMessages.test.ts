import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseResponseMessages,
  parseTurnContext,
  serializeResponseMessages,
  serializeTurnContext
} from './storage.ts'

test('serializeResponseMessages returns null for undefined', () => {
  assert.equal(serializeResponseMessages(undefined), null)
})

test('serializeResponseMessages returns null for empty array', () => {
  assert.equal(serializeResponseMessages([]), null)
})

test('serializeResponseMessages serializes non-empty array', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking...' },
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
    }
  ]

  const serialized = serializeResponseMessages(messages)
  assert.equal(typeof serialized, 'string')
  assert.deepEqual(JSON.parse(serialized!), messages)
})

test('parseResponseMessages returns undefined for null', () => {
  assert.equal(parseResponseMessages(null), undefined)
})

test('parseResponseMessages returns undefined for empty string', () => {
  assert.equal(parseResponseMessages(''), undefined)
})

test('parseResponseMessages returns undefined for empty array JSON', () => {
  assert.equal(parseResponseMessages('[]'), undefined)
})

test('parseResponseMessages returns undefined for invalid JSON', () => {
  assert.equal(parseResponseMessages('{broken'), undefined)
})

test('parseResponseMessages round-trips with serializeResponseMessages', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'tc-gemini-1', toolName: 'bash', input: { command: 'ls' } }
      ],
      providerOptions: { google: { someField: true } }
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc-gemini-1',
          toolName: 'bash',
          output: { type: 'text', value: 'file1\nfile2' }
        }
      ]
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Found files.' }]
    }
  ]

  const serialized = serializeResponseMessages(messages)
  const parsed = parseResponseMessages(serialized)
  assert.deepEqual(parsed, messages)
})

test('parseResponseMessages preserves Gemini provider options and tool call IDs', () => {
  const geminiMessages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'gemini-stable-id-abc123',
          toolName: 'read',
          input: { path: '/workspace/file.ts' },
          providerOptions: { google: { functionCallingConfig: {} } }
        }
      ],
      providerOptions: { google: { candidateIndex: 0 } }
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'gemini-stable-id-abc123',
          toolName: 'read',
          output: { type: 'text', value: 'export const x = 1' },
          providerOptions: { google: {} }
        }
      ]
    }
  ]

  const serialized = serializeResponseMessages(geminiMessages)
  const parsed = parseResponseMessages(serialized)

  assert.deepEqual(parsed, geminiMessages)
  // Verify IDs and provider options are preserved exactly
  const firstMsg = parsed![0] as {
    content: Array<{ toolCallId: string; providerOptions?: unknown }>
  }
  assert.equal(firstMsg.content[0].toolCallId, 'gemini-stable-id-abc123')
  assert.deepEqual(firstMsg.content[0].providerOptions, {
    google: { functionCallingConfig: {} }
  })
})

// --- turnContext serialization ---

test('serializeTurnContext returns null for undefined', () => {
  assert.equal(serializeTurnContext(undefined), null)
})

test('serializeTurnContext returns null for empty context', () => {
  assert.equal(serializeTurnContext({}), null)
  assert.equal(serializeTurnContext({ reminder: '   ' }), null)
  assert.equal(serializeTurnContext({ memoryEntries: [] }), null)
})

test('serializeTurnContext serializes reminder and memoryEntries', () => {
  const ctx = { reminder: 'tools changed', memoryEntries: ['mem1', 'mem2'] }
  const serialized = serializeTurnContext(ctx)
  assert.equal(typeof serialized, 'string')
  assert.deepEqual(JSON.parse(serialized!), ctx)
})

test('parseTurnContext returns undefined for null', () => {
  assert.equal(parseTurnContext(null), undefined)
})

test('parseTurnContext returns undefined for empty JSON object', () => {
  assert.equal(parseTurnContext('{}'), undefined)
})

test('parseTurnContext round-trips with serializeTurnContext', () => {
  const ctx = { reminder: '<reminder>write disabled</reminder>', memoryEntries: ['entry1'] }
  const serialized = serializeTurnContext(ctx)
  const parsed = parseTurnContext(serialized)
  assert.deepEqual(parsed, ctx)
})

test('parseTurnContext handles reminder-only context', () => {
  const ctx = { reminder: 'some reminder' }
  const parsed = parseTurnContext(serializeTurnContext(ctx))
  assert.deepEqual(parsed, { reminder: 'some reminder' })
})

test('parseTurnContext handles memoryEntries-only context', () => {
  const ctx = { memoryEntries: ['a', 'b'] }
  const parsed = parseTurnContext(serializeTurnContext(ctx))
  assert.deepEqual(parsed, { memoryEntries: ['a', 'b'] })
})
