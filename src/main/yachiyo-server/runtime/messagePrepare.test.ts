import assert from 'node:assert/strict'
import test from 'node:test'

import {
  balanceHistoryMessages,
  prepareAiSdkMessages,
  prepareModelMessages
} from './messagePrepare.ts'
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
        "<memory>\nBackground context from past conversations. Focus on the user's query first;\noverlapping terms do not make an entry relevant — judge by actual applicability.\n- No persisted memories yet.\n</memory>"
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
        "<memory>\nBackground context from past conversations. Focus on the user's query first;\noverlapping terms do not make an entry relevant — judge by actual applicability.\n- User cares about Apex coverage\n</memory>"
      ].join('\n\n')
    },
    { role: 'assistant', content: 'Done. Three new headlines.' },
    {
      role: 'user',
      content: [
        'Now check the weather',
        turn2Reminder,
        "<memory>\nBackground context from past conversations. Focus on the user's query first;\noverlapping terms do not make an entry relevant — judge by actual applicability.\n- User prefers metric units\n</memory>"
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
        {
          type: 'text',
          text: "<memory>\nBackground context from past conversations. Focus on the user's query first;\noverlapping terms do not make an entry relevant — judge by actual applicability.\n- User likes cats\n</memory>"
        }
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

// --- balanceHistoryMessages ---

test('balanceHistoryMessages returns original array when already balanced', () => {
  const messages = [
    { role: 'user' as const, content: 'List files' },
    {
      role: 'assistant' as const,
      content: [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'glob', input: { pattern: '*' } }
      ]
    },
    {
      role: 'tool' as const,
      content: [{ type: 'tool-result', toolCallId: 'tc-1', toolName: 'glob', output: 'file1.txt' }]
    },
    { role: 'assistant' as const, content: 'Here are the files.' }
  ]

  const result = balanceHistoryMessages(messages as never)
  assert.equal(result, messages, 'should return same reference when no changes needed')
})

test('balanceHistoryMessages strips orphaned tool-result without matching tool-call', () => {
  const messages = [
    { role: 'user' as const, content: 'List files' },
    {
      role: 'assistant' as const,
      content: [{ type: 'text', text: 'Let me check.' }]
    },
    {
      role: 'tool' as const,
      content: [
        // This tool-result references a tool-call ID that doesn't exist
        { type: 'tool-result', toolCallId: 'orphan-1', toolName: 'glob', output: 'file1.txt' }
      ]
    },
    { role: 'user' as const, content: 'What did you find?' }
  ]

  const result = balanceHistoryMessages(messages as never)
  // The orphaned tool message should be removed entirely
  assert.equal(result.length, 3)
  assert.equal(result[0].role, 'user')
  assert.equal(result[1].role, 'assistant')
  assert.equal(result[2].role, 'user')
})

test('balanceHistoryMessages injects synthetic result for unmatched tool-call before user message', () => {
  const messages = [
    { role: 'user' as const, content: 'Search for it' },
    {
      role: 'assistant' as const,
      content: [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'glob', input: { pattern: '*' } }
      ]
    },
    // No tool message follows — directly a user message (steer)
    { role: 'user' as const, content: 'Never mind, do this instead' }
  ]

  const result = balanceHistoryMessages(messages as never)
  assert.equal(result.length, 4, 'should inject synthetic tool message')
  assert.equal(result[2].role, 'tool')
  const toolContent = (result[2] as { content: Array<{ toolCallId: string }> }).content
  assert.equal(toolContent[0].toolCallId, 'tc-1')
  assert.equal(result[3].role, 'user')
})

test('balanceHistoryMessages injects synthetic result for unmatched tool-call at end', () => {
  const messages = [
    { role: 'user' as const, content: 'Search' },
    {
      role: 'assistant' as const,
      content: [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'bash', input: { command: 'ls' } }
      ]
    }
  ]

  const result = balanceHistoryMessages(messages as never)
  assert.equal(result.length, 3)
  assert.equal(result[2].role, 'tool')
})

test('balanceHistoryMessages handles mixed valid and orphaned tool-results', () => {
  const messages = [
    { role: 'user' as const, content: 'Do things' },
    {
      role: 'assistant' as const,
      content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'glob', input: {} }]
    },
    {
      role: 'tool' as const,
      content: [
        { type: 'tool-result', toolCallId: 'tc-1', toolName: 'glob', output: 'ok' },
        // This one has no matching tool-call
        { type: 'tool-result', toolCallId: 'orphan-1', toolName: 'read', output: 'bad' }
      ]
    },
    { role: 'assistant' as const, content: 'Done.' }
  ]

  const result = balanceHistoryMessages(messages as never)
  // The orphaned result should be stripped but the valid one kept
  const toolMsg = result.find((m) => m.role === 'tool') as {
    content: Array<{ toolCallId: string }>
  }
  assert.ok(toolMsg)
  assert.equal(toolMsg.content.length, 1)
  assert.equal(toolMsg.content[0].toolCallId, 'tc-1')
})

test('balanceHistoryMessages patches tool-call parts missing toolCallId from adjacent tool-result', () => {
  // Simulates a stored responseMessages where the tool-call object lost its
  // toolCallId but the adjacent tool-result still has it.
  const messages = [
    { role: 'user' as const, content: 'Search files' },
    {
      role: 'assistant' as const,
      content: [
        // toolCallId is missing/undefined on the tool-call
        { type: 'tool-call', toolName: 'glob', input: { pattern: '*.ts' } },
        { type: 'tool-call', toolCallId: 'read:1', toolName: 'read', input: { path: 'a.ts' } }
      ]
    },
    {
      role: 'tool' as const,
      content: [
        { type: 'tool-result', toolCallId: 'glob:1', toolName: 'glob', output: 'a.ts' },
        { type: 'tool-result', toolCallId: 'read:1', toolName: 'read', output: 'content' }
      ]
    },
    { role: 'assistant' as const, content: 'Here are the results.' }
  ]

  const result = balanceHistoryMessages(messages as never)

  // The tool-call for glob should now have toolCallId: 'glob:1' from the result
  const assistantMsg = result.find((m) => m.role === 'assistant' && Array.isArray(m.content)) as {
    content: Array<{ type?: string; toolCallId?: string; toolName?: string }>
  }
  const globCall = (
    assistantMsg.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>
  ).find((p) => p.type === 'tool-call' && p.toolName === 'glob')
  assert.equal(globCall?.toolCallId, 'glob:1', 'should patch toolCallId from adjacent tool-result')

  // The read tool-call should be unchanged
  const readCall = (
    assistantMsg.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>
  ).find((p) => p.type === 'tool-call' && p.toolName === 'read')
  assert.equal(readCall?.toolCallId, 'read:1')

  // Both tool-results should be preserved (no orphans now)
  const toolMsg = result.find((m) => m.role === 'tool') as {
    content: Array<{ toolCallId: string }>
  }
  assert.equal(toolMsg.content.length, 2)
})

test('prepareAiSdkMessages applies balanceHistoryMessages guard', () => {
  // Simulates messages that would cause "tool call id X not found" without the guard
  const messages = [
    { role: 'user' as const, content: 'Check files' },
    {
      role: 'assistant' as const,
      content: [{ type: 'text', text: 'Searching...' }]
    },
    {
      role: 'tool' as const,
      content: [{ type: 'tool-result', toolCallId: 'ghost-1', toolName: 'glob', output: 'result' }]
    },
    { role: 'user' as const, content: 'Continue' }
  ]

  const result = prepareAiSdkMessages(messages as never)
  // The orphaned tool message should be stripped
  assert.ok(!result.some((m) => m.role === 'tool'), 'orphaned tool message should be removed')
})
