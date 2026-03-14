import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareAiSdkMessages, prepareModelMessages } from './messagePrepare.ts'
import { SYSTEM_PROMPT } from './prompt.ts'

test('message prepare prepends the system prompt and drops empty messages', () => {
  const prepared = prepareModelMessages({
    history: [
      { role: 'user', content: '   ' },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', content: 'What is next?' },
    ],
  })

  assert.deepEqual(prepared, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'assistant', content: 'Previous answer' },
    { role: 'user', content: 'What is next?' },
  ])
})

test('message prepare converts prepared messages into AI SDK messages', () => {
  const prepared = prepareAiSdkMessages([
    { role: 'system', content: 'You are concise.' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'Say hello' },
  ])

  assert.deepEqual(prepared, [
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: 'Say hello' },
  ])
})
