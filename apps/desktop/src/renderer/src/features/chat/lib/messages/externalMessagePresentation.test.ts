import assert from 'node:assert/strict'
import test from 'node:test'

import type { Message } from '../../../../app/types.ts'
import { buildExternalAssistantPresentation } from './externalMessagePresentation.ts'

const ASSISTANT_MESSAGE: Message = {
  id: 'assistant-1',
  threadId: 'thread-1',
  parentMessageId: 'user-1',
  role: 'assistant',
  content: 'Internal response',
  visibleReply: 'Visible response',
  status: 'completed',
  createdAt: '2026-08-13T00:00:00.000Z',
  modelId: 'google/gemini-3-flash'
}

test('tool-free external replies show their normalized model below the visible response', () => {
  assert.deepEqual(buildExternalAssistantPresentation(ASSISTANT_MESSAGE, 0), {
    content: 'Visible response',
    modelLabel: 'gemini-3-flash',
    standaloneModelLabel: 'gemini-3-flash'
  })
})

test('external tool summaries own the model label without duplicating a standalone label', () => {
  assert.deepEqual(buildExternalAssistantPresentation(ASSISTANT_MESSAGE, 1), {
    content: 'Visible response',
    modelLabel: 'gemini-3-flash',
    standaloneModelLabel: null
  })
})

test('empty external replies do not render standalone model metadata', () => {
  assert.equal(
    buildExternalAssistantPresentation(
      { ...ASSISTANT_MESSAGE, content: 'Internal response', visibleReply: '   ' },
      0
    ).standaloneModelLabel,
    null
  )
})
