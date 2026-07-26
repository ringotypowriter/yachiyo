import test from 'node:test'
import assert from 'node:assert/strict'

import { toRunHistoryMessages } from './runHistory.ts'

const path = [
  { id: 'm1', role: 'user' as const, content: 'first question' },
  { id: 'm2', role: 'assistant' as const, content: 'answer' },
  { id: 'm3', role: 'user' as const, content: 'write a recap of this conversation' }
]

test('applies the request message content override', () => {
  const messages = toRunHistoryMessages(path, 'm3', 'expanded query')
  assert.equal(messages[2].content, 'expanded query')
})

test('keeps the request message content when the override is empty', () => {
  const messages = toRunHistoryMessages(path, 'm3', '')
  assert.equal(messages[2].content, 'write a recap of this conversation')
})

test('keeps the request message content when there is no override', () => {
  const messages = toRunHistoryMessages(path, 'm3')
  assert.equal(messages[2].content, 'write a recap of this conversation')
})

test('leaves other messages untouched', () => {
  const messages = toRunHistoryMessages(path, 'm3', 'expanded query')
  assert.deepEqual(
    messages.map((m) => m.content),
    ['first question', 'answer', 'expanded query']
  )
})
