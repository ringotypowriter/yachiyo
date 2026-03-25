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

test('message prepare can add soul, agent, hint, and memory layers without mutating user content', () => {
  const soulContent =
    '# SOUL\n\n## Evolved Traits\n### 2026-03-25\n- Keeps replies crisp under pressure\n- Prefers concrete next actions'
  const prepared = prepareModelMessages({
    personality: {
      basePersona: SYSTEM_PROMPT
    },
    soul: {
      content: soulContent
    },
    user: {
      content: '# USER\n\n## Work Style\n- Likes decisions with explicit tradeoffs'
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
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content: [
        '以下是来自 SOUL.md 的自我模型与人格延续记录，请整体吸收并自然融入当前人格：',
        '',
        soulContent
      ].join('\n')
    },
    {
      role: 'system',
      content: [
        '以下是来自 USER.md 的稳定用户理解，请把它当作长期协作画像，而不是当前临时任务状态：',
        '',
        '# USER\n\n## Work Style\n- Likes decisions with explicit tradeoffs'
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
