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
  assert.equal(messages.at(-1)?.role, 'user')
  assert.equal(messages.at(-1)?.content, '<msg from="Bob">fresh turn</msg>')
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
