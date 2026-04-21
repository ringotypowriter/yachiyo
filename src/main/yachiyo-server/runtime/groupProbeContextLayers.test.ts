import assert from 'node:assert/strict'
import test from 'node:test'

import { compileGroupProbeContextLayers } from './groupProbeContextLayers.ts'

test('compileGroupProbeContextLayers keeps stable prefix, summary, history, and current delta separated', () => {
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    rollingSummary: 'The group was joking about keyboards.',
    history: [
      { role: 'user', content: '<msg from="Alice">old turn</msg>' },
      { role: 'assistant', content: 'silent, not worth joining' }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.equal(messages.length, 6)
  assert.deepEqual(messages[0], { role: 'system', content: 'Stable group behavior rules.' })
  assert.deepEqual(messages[1], { role: 'system', content: 'You are the group probe.' })
  assert.equal(messages[2]?.role, 'user')
  assert.match(messages[2]?.content as string, /conversation_summary/)
  assert.equal(messages[3]?.role, 'user')
  assert.equal(messages[3]?.content, '<msg from="Alice">old turn</msg>')
  assert.equal(messages[4]?.role, 'assistant')
  assert.equal(messages[4]?.content, 'silent, not worth joining')
  assert.equal(messages[5]?.role, 'user')
  assert.equal(messages[5]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers preserves assistant responseMessages for cache-stable replay', () => {
  const responseMessages = [
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'thinking about whether to speak' },
        { type: 'tool-call' as const, toolCallId: 'tc1', toolName: 'send_group_message', input: {} }
      ]
    },
    {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: 'tc1',
          toolName: 'send_group_message',
          output: { type: 'text' as const, value: 'Message sent.' }
        }
      ]
    }
  ]

  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [
      { role: 'user', content: '<msg from="Alice">old turn</msg>' },
      {
        role: 'assistant',
        content: 'thinking about whether to speak',
        responseMessages
      }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.equal(messages[0]?.role, 'system')
  assert.equal(messages[1]?.role, 'system')
  assert.equal(messages[2]?.role, 'user')
  assert.deepEqual(messages[3], responseMessages[0])
  assert.deepEqual(messages[4], responseMessages[1])
  assert.equal(messages[5]?.role, 'user')
  assert.equal(messages[5]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers trims the last sentence from plain assistant monologue replay', () => {
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [
      {
        role: 'assistant',
        content: '她刚刚是在试探我，群里节奏也很快，我现在插话有点怪。先不说了。'
      }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.equal(messages[2]?.role, 'assistant')
  assert.equal(messages[2]?.content, '她刚刚是在试探我，群里节奏也很快，我现在插话有点怪。')
  assert.equal(messages[3]?.role, 'user')
})

test('compileGroupProbeContextLayers trims the last sentence from text-only assistant responseMessages', () => {
  const responseMessages = [
    {
      role: 'assistant' as const,
      content: [
        {
          type: 'text' as const,
          text: 'The room is moving fast. I should probably stay quiet.'
        }
      ]
    }
  ]

  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [
      {
        role: 'assistant',
        content: 'The room is moving fast. I should probably stay quiet.',
        responseMessages
      }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.deepEqual(messages[2], {
    role: 'assistant',
    content: [{ type: 'text', text: 'The room is moving fast.' }]
  })
  assert.equal(messages[3]?.role, 'user')
})

test('compileGroupProbeContextLayers preserves one-sentence assistant monologue replay', () => {
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [{ role: 'assistant', content: 'Not worth jumping in.' }],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.equal(messages[2]?.role, 'assistant')
  assert.equal(messages[2]?.content, 'Not worth jumping in.')
  assert.equal(messages[3]?.role, 'user')
})

test('compileGroupProbeContextLayers trims tool-assisted silent turns unless they sent a group message', () => {
  const responseMessages = [
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'checking context' },
        { type: 'tool-call' as const, toolCallId: 'tc1', toolName: 'web_search', input: {} }
      ]
    },
    {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: 'tc1',
          toolName: 'web_search',
          output: { type: 'text' as const, value: 'search results' }
        }
      ]
    },
    {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'The room is moving fast. I should stay quiet.' }]
    }
  ]

  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [
      {
        role: 'assistant',
        content: 'The room is moving fast. I should stay quiet.',
        responseMessages
      }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.deepEqual(messages[2], responseMessages[0])
  assert.deepEqual(messages[3], responseMessages[1])
  assert.deepEqual(messages[4], {
    role: 'assistant',
    content: [{ type: 'text', text: 'The room is moving fast.' }]
  })
  assert.equal(messages[5]?.role, 'user')
})
