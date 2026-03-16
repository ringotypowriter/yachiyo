import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareAiSdkMessages, prepareModelMessages } from './messagePrepare.ts'
import { SYSTEM_PROMPT } from './prompt.ts'

test('message prepare prepends the system prompt and drops empty messages', () => {
  const prepared = prepareModelMessages({
    history: [
      { role: 'user', content: '   ' },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', content: 'What is next?' }
    ]
  })

  assert.deepEqual(prepared, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'assistant', content: 'Previous answer' },
    { role: 'user', content: 'What is next?' }
  ])
})

test('message prepare converts prepared messages into AI SDK messages', () => {
  const prepared = prepareAiSdkMessages([
    { role: 'system', content: 'You are concise.' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'Say hello' }
  ])

  assert.deepEqual(prepared, [
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: 'Say hello' }
  ])
})

test('message prepare keeps image input close to the user text payload', () => {
  const prepared = prepareModelMessages({
    history: [
      {
        role: 'user',
        content: 'Look at this',
        images: [
          {
            dataUrl: 'data:image/png;base64,AAAA',
            mediaType: 'image/png',
            filename: 'cat.png'
          }
        ]
      },
      { role: 'assistant', content: 'Nice.' },
      {
        role: 'user',
        content: '',
        images: [
          {
            dataUrl: 'data:image/jpeg;base64,BBBB',
            mediaType: 'image/jpeg'
          }
        ]
      }
    ]
  })

  assert.deepEqual(prepared, [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this' },
        {
          type: 'image',
          image: 'AAAA',
          mediaType: 'image/png'
        }
      ]
    },
    { role: 'assistant', content: 'Nice.' },
    {
      role: 'user',
      content: [
        {
          type: 'image',
          image: 'BBBB',
          mediaType: 'image/jpeg'
        }
      ]
    }
  ])
})
