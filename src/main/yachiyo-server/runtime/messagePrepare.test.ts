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

  const soulPreamble =
    'The following is your self-model and personality continuity record from SOUL.md. Absorb it holistically and integrate it naturally into your current persona:'
  const userPreamble =
    'The following is your durable understanding of the user from USER.md. Treat it as a long-term collaboration profile, not as current task state:'

  assert.deepEqual(prepared, [
    // Consolidated system message (stable prefix)
    {
      role: 'system',
      content: [
        SYSTEM_PROMPT,
        [soulPreamble, '', soulContent].join('\n'),
        [
          userPreamble,
          '',
          '# USER\n\n## Work Style\n- Likes decisions with explicit tradeoffs'
        ].join('\n'),
        'Workspace: /tmp/thread-1'
      ].join('\n\n')
    },
    // User query with per-turn context merged in
    {
      role: 'user',
      content: [
        'Inspect the workspace',
        '<reminder>\nTool availability changed for this turn:\n- Disabled: edit.\n</reminder>',
        '<memory>\n- No persisted memories yet.\n</memory>'
      ].join('\n\n')
    }
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

test('message prepare replays historical turn context inline on older user messages', () => {
  // Simulates a multi-turn run where turn 1 carried its own reminder + memory
  // entries; turn 2 (the current turn) brings a fresh reminder via the live
  // `hint`/`memory` inputs. The replayed turn-1 user message should regain its
  // original tail so the model sees full temporal continuity, and the live
  // turn-2 reminder should still attach to the LAST user message only.
  const turn1Reminder = '<reminder>\nCurrent time (local):\n- Time: 09:00:01\n</reminder>'
  const turn2Reminder = '<reminder>\nCurrent time (local):\n- Time: 09:05:42\n</reminder>'

  const prepared = prepareModelMessages({
    personality: { basePersona: SYSTEM_PROMPT },
    history: [
      {
        role: 'user',
        content: 'Check the news',
        turnContext: {
          reminder: turn1Reminder,
          memoryEntries: ['User cares about Apex coverage']
        }
      },
      { role: 'assistant', content: 'Done. Three new headlines.' },
      // Current turn's request message — must NOT carry turnContext, the
      // live hint/memory below will be appended to it instead.
      { role: 'user', content: 'Now check the weather' }
    ],
    hint: { reminder: turn2Reminder },
    memory: { entries: ['User prefers metric units'] }
  })

  assert.deepEqual(prepared, [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        'Check the news',
        turn1Reminder,
        '<memory>\n- User cares about Apex coverage\n</memory>'
      ].join('\n\n')
    },
    { role: 'assistant', content: 'Done. Three new headlines.' },
    {
      role: 'user',
      content: [
        'Now check the weather',
        turn2Reminder,
        '<memory>\n- User prefers metric units\n</memory>'
      ].join('\n\n')
    }
  ])
})

test('message prepare emits historical multimodal turn context as separate text parts after images', () => {
  // The live multimodal path (`appendTurnContextToUserMessage` array branch)
  // appends each turn-context piece as its own text block AFTER the existing
  // image blocks. Historical replay must mirror that exact structural order
  // so cache prefixes stay byte-stable and providers see the same image/text
  // pairing the model originally received.
  const turn1Reminder = '<reminder>\nCurrent time (local):\n- Time: 09:00:01\n</reminder>'
  const turn2Reminder = '<reminder>\nCurrent time (local):\n- Time: 09:05:42\n</reminder>'

  const prepared = prepareModelMessages({
    personality: { basePersona: SYSTEM_PROMPT },
    history: [
      {
        role: 'user',
        content: 'What is in this picture?',
        images: [
          {
            dataUrl: 'data:image/png;base64,AAAA',
            mediaType: 'image/png',
            filename: 'cat.png'
          }
        ],
        turnContext: {
          reminder: turn1Reminder,
          memoryEntries: ['User likes cats']
        }
      },
      { role: 'assistant', content: 'A tabby cat on a windowsill.' },
      { role: 'user', content: 'And now this one?' }
    ],
    hint: { reminder: turn2Reminder }
  })

  assert.deepEqual(prepared, [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image', image: 'AAAA', mediaType: 'image/png' },
        { type: 'text', text: turn1Reminder },
        { type: 'text', text: '<memory>\n- User likes cats\n</memory>' }
      ]
    },
    { role: 'assistant', content: 'A tabby cat on a windowsill.' },
    {
      role: 'user',
      content: ['And now this one?', turn2Reminder].join('\n\n')
    }
  ])
})

test('message prepare leaves user message untouched when turn context is empty', () => {
  // Sanity check: a historical user message with an empty turnContext object
  // (e.g. a turn where neither a reminder nor memory entries were injected)
  // must not gain any extra trailing newlines or stray markers.
  const prepared = prepareModelMessages({
    personality: { basePersona: SYSTEM_PROMPT },
    history: [
      {
        role: 'user',
        content: 'Hello',
        turnContext: {}
      }
    ]
  })

  assert.deepEqual(prepared, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Hello' }
  ])
})
