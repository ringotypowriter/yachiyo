import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMessagePresentation } from './messagePresentation'

const BASE_MESSAGE = {
  id: 'message-1',
  threadId: 'thread-1',
  role: 'assistant' as const,
  createdAt: '2026-03-15T00:00:00.000Z'
}

test('buildMessagePresentation hides an empty streaming placeholder until the first token arrives', () => {
  const placeholder = buildMessagePresentation({
    ...BASE_MESSAGE,
    content: '',
    status: 'streaming'
  })

  assert.equal(placeholder.showContent, false)
  assert.equal(placeholder.showBubble, false)
  assert.deepEqual(placeholder.footer, { kind: 'streaming' })

  const startedStreaming = buildMessagePresentation({
    ...BASE_MESSAGE,
    content: 'Hello',
    status: 'streaming'
  })

  assert.equal(startedStreaming.showContent, true)
  assert.equal(startedStreaming.showBubble, true)
  assert.deepEqual(startedStreaming.footer, { kind: 'streaming' })
})

test('buildMessagePresentation keeps completed replies free of footer metadata', () => {
  const completed = buildMessagePresentation({
    ...BASE_MESSAGE,
    content: 'Hello',
    status: 'completed',
    modelId: 'gpt-5',
    providerName: 'work'
  })

  assert.equal(completed.showContent, true)
  assert.equal(completed.showBubble, true)
  assert.equal(completed.footer, null)
})
