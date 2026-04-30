import assert from 'node:assert/strict'
import test from 'node:test'

import type { ModelMessage } from '../types.ts'
import { prepareCodexMessages } from './codexOpenai.ts'

test('prepareCodexMessages moves the first text system message into instructions', () => {
  const userMessage = { role: 'user', content: 'Hello' } satisfies ModelMessage
  const assistantMessage = { role: 'assistant', content: 'Hi' } satisfies ModelMessage

  const result = prepareCodexMessages(
    [
      { role: 'system', content: 'Use short replies.' },
      userMessage,
      { role: 'system', content: 'This later system message is removed.' },
      assistantMessage
    ],
    {
      openai: {
        promptCacheKey: 'thread-1',
        store: false
      }
    }
  )

  assert.deepEqual(result.messages, [userMessage, assistantMessage])
  assert.deepEqual(result.options, {
    openai: {
      promptCacheKey: 'thread-1',
      store: false,
      instructions: 'Use short replies.'
    }
  })
})

test('prepareCodexMessages uses default instructions when no text system message exists', () => {
  const userMessage = { role: 'user', content: 'Hello' } satisfies ModelMessage

  const result = prepareCodexMessages(
    [
      {
        role: 'system',
        content: [{ type: 'text', text: 'Structured system text is not accepted here.' }]
      } as never,
      userMessage
    ],
    {
      openai: {
        store: false
      }
    }
  )

  assert.deepEqual(result.messages, [userMessage])
  assert.deepEqual(result.options, {
    openai: {
      store: false,
      instructions: 'You are a helpful assistant.'
    }
  })
})
