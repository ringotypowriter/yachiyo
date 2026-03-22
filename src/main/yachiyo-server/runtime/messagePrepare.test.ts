import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareAiSdkMessages, prepareModelMessages } from './messagePrepare.ts'
import { SYSTEM_PROMPT } from './prompt.ts'

test('message prepare compiles explicit context layers and drops empty messages', () => {
  const prepared = prepareModelMessages({
    personality: {
      basePersona: SYSTEM_PROMPT
    },
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

test('message prepare can add agent, hint, and memory layers without mutating user content', () => {
  const prepared = prepareModelMessages({
    personality: {
      basePersona: SYSTEM_PROMPT,
      evolvedTraits: ['Keeps replies crisp under pressure', 'Prefers concrete next actions']
    },
    history: [{ role: 'user', content: 'Inspect the workspace' }],
    agent: {
      instructions: 'Workspace: /tmp/thread-1'
    },
    hint: {
      reminder:
        '<reminder>\nTool availability changed for this turn:\n- Disabled: edit.\n</reminder>'
    },
    memory: {
      entries: ['No persisted memories yet.']
    }
  })

  assert.deepEqual(prepared, [
    {
      role: 'system',
      content: [
        SYSTEM_PROMPT,
        '',
        '以下是来自 SOUL 的人格补充，请自然吸收并保持整体稳定：',
        '- Keeps replies crisp under pressure',
        '- Prefers concrete next actions'
      ].join('\n')
    },
    { role: 'system', content: 'Workspace: /tmp/thread-1' },
    {
      role: 'system',
      content:
        '<reminder>\nTool availability changed for this turn:\n- Disabled: edit.\n</reminder>'
    },
    {
      role: 'system',
      content: ['<memory>', '- No persisted memories yet.', '</memory>'].join('\n')
    },
    { role: 'user', content: 'Inspect the workspace' }
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
    personality: {
      basePersona: SYSTEM_PROMPT
    },
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
