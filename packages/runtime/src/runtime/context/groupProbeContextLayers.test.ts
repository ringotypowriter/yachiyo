import assert from 'node:assert/strict'
import test from 'node:test'

import { compileGroupProbeContextLayers } from './groupProbeContextLayers.ts'

test('compileGroupProbeContextLayers keeps stable prefix, summary, history, and current delta separated', () => {
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    contextHandoffSummary: 'The group was joking about keyboards.',
    history: [
      { role: 'user', content: '<msg from="Alice">old turn</msg>' },
      { role: 'assistant', content: 'silent, not worth joining' }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.equal(messages.length, 5)
  assert.deepEqual(messages[0], { role: 'system', content: 'Stable group behavior rules.' })
  assert.deepEqual(messages[1], { role: 'system', content: 'You are the group probe.' })
  assert.equal(messages[2]?.role, 'user')
  assert.match(messages[2]?.content as string, /context_handoff/)
  assert.equal(messages[3]?.role, 'user')
  assert.equal(messages[3]?.content, '<msg from="Alice">old turn</msg>')
  assert.equal(messages[4]?.role, 'user')
  assert.equal(messages[4]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers replays assistant turns as sent-text chat messages, never raw responseMessages', () => {
  const responseMessages = [
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'private monologue that must never replay' },
        {
          type: 'tool-call' as const,
          toolCallId: 'tc1',
          toolName: 'send_group_message',
          input: { message: 'hello group' }
        }
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
        content: 'private monologue that must never replay',
        responseMessages
      }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.equal(messages[0]?.role, 'system')
  assert.equal(messages[1]?.role, 'system')
  assert.equal(messages[2]?.role, 'user')
  assert.equal(messages[3]?.role, 'user')
  assert.equal(messages[3]?.content, '<msg from="Yachiyo">hello group</msg>')
  // No raw assistant turn, tool call, or monologue text survives into the replay.
  assert.ok(messages.every((m) => m.role !== 'assistant' && m.role !== 'tool'))
  assert.ok(
    messages.every((m) => typeof m.content !== 'string' || !m.content.includes('private monologue'))
  )
  assert.equal(messages[4]?.role, 'user')
  assert.equal(messages[4]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers preserves successful sends as safe group context when reasoning is missing', () => {
  const responseMessages = [
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'thinking about whether to speak' },
        {
          type: 'tool-call' as const,
          toolCallId: 'tc1',
          toolName: 'send_group_message',
          input: { message: 'Yeah, that sounds right [test].' }
        }
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
      {
        role: 'assistant',
        content: 'thinking about whether to speak',
        responseMessages
      }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.equal(messages[2]?.role, 'user')
  assert.equal(messages[2]?.content, '<msg from="Yachiyo">Yeah, that sounds right ⟦test⟧.</msg>')
  assert.equal(messages[3]?.role, 'user')
  assert.equal(messages[3]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers drops failed group message send attempts', () => {
  const responseMessages = [
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'I should reply.' },
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
          output: { type: 'text' as const, value: 'Failed to send message.' }
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
        content: 'I should reply.',
        responseMessages
      }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.equal(messages[2]?.role, 'user')
  assert.equal(messages[2]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers drops plain silent assistant monologue replay', () => {
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

  assert.equal(messages[2]?.role, 'user')
  assert.equal(messages[2]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers drops text-only silent assistant responseMessages', () => {
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

  assert.equal(messages[2]?.role, 'user')
  assert.equal(messages[2]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers drops one-sentence silent assistant monologue replay', () => {
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [{ role: 'assistant', content: 'Not worth jumping in.' }],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  assert.equal(messages[2]?.role, 'user')
  assert.equal(messages[2]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers trims the oldest history turns to the token budget', () => {
  // ASCII content: estimateTextTokens ≈ length / 4, so each turn ≈ 100 tokens.
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [
      { role: 'user', content: `<msg from="A">${'a'.repeat(390)}</msg>` },
      { role: 'user', content: `<msg from="B">${'b'.repeat(390)}</msg>` },
      { role: 'user', content: `<msg from="C">${'c'.repeat(390)}</msg>` }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>',
    historyTokenBudget: 150
  })

  const contents = messages.map((message) => message.content as string)
  // Only the most recent turn fits the 150-token budget; older ones are dropped.
  assert.ok(contents.some((content) => content.includes('from="C"')))
  assert.ok(!contents.some((content) => content.includes('from="A"')))
  assert.ok(!contents.some((content) => content.includes('from="B"')))
  // Current turn is always preserved.
  assert.equal(messages[messages.length - 1]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers always keeps at least the newest turn even if it exceeds budget', () => {
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [{ role: 'user', content: `<msg from="A">${'a'.repeat(4000)}</msg>` }],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>',
    historyTokenBudget: 10
  })

  assert.ok(messages.some((message) => (message.content as string).includes('from="A"')))
})

test('compileGroupProbeContextLayers never replays an assistant reply without its user delta', () => {
  const responseMessages = [
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'ok' },
        {
          type: 'tool-call' as const,
          toolCallId: 'tc1',
          toolName: 'send_group_message',
          input: { message: 'hi' }
        }
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
    // A large user delta followed by its small assistant reply — a tight budget
    // must keep them together, not the reply alone.
    history: [
      { role: 'user', content: `<msg from="A">${'a'.repeat(4000)}</msg>` },
      { role: 'assistant', content: 'ok', responseMessages }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>',
    historyTokenBudget: 100
  })

  const hasAssistantReplay = messages.some((message) => message.role === 'assistant')
  const hasUserDelta = messages.some(
    (message) => typeof message.content === 'string' && message.content.includes('from="A"')
  )
  assert.ok(
    !hasAssistantReplay || hasUserDelta,
    'assistant reply must never be replayed without its user delta'
  )
})

test('compileGroupProbeContextLayers keeps a synthetic self-reply with its user delta under a tight budget', () => {
  // Reasoning-replay fallback renders the assistant turn as a synthetic
  // `<msg from="Yachiyo">` with role 'user'; it must still group with its delta.
  const responseMessages = [
    {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'thinking' },
        {
          type: 'tool-call' as const,
          toolCallId: 'tc1',
          toolName: 'send_group_message',
          input: { message: 'hey there' }
        }
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
      { role: 'user', content: `<msg from="Alice">${'a'.repeat(2000)}</msg>` },
      { role: 'assistant', content: 'thinking', responseMessages }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>',
    historyTokenBudget: 50
  })

  const hasSelfReply = messages.some(
    (m) => typeof m.content === 'string' && m.content.includes('from="Yachiyo"')
  )
  const hasDelta = messages.some(
    (m) => typeof m.content === 'string' && m.content.includes('from="Alice"')
  )
  assert.ok(!hasSelfReply || hasDelta, 'self-reply must not appear without its user delta')
  assert.ok(
    hasSelfReply && hasDelta,
    'the delta + its self-reply form one unit and are kept together'
  )
})

test('compileGroupProbeContextLayers re-asserts the style reminder right before the current turn', () => {
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [{ role: 'user', content: '<msg from="Alice">old turn</msg>' }],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>',
    styleReminder: 'Stay in your own voice.'
  })

  const last = messages[messages.length - 1]
  const secondLast = messages[messages.length - 2]
  assert.equal(last?.content, '<msg from="Bob">fresh turn</msg>')
  assert.equal(secondLast?.role, 'user')
  assert.match(secondLast?.content as string, /<style_reminder>/)
  assert.match(secondLast?.content as string, /Stay in your own voice\./)
})

test('compileGroupProbeContextLayers omits the style reminder when there is no replayable history', () => {
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>',
    styleReminder: 'Stay in your own voice.'
  })

  assert.ok(
    !messages.some(
      (message) => typeof message.content === 'string' && message.content.includes('style_reminder')
    )
  )
})

test('compileGroupProbeContextLayers drops tool-assisted silent turns unless they sent a group message', () => {
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

  assert.equal(messages[2]?.role, 'user')
  assert.equal(messages[2]?.content, '<msg from="Bob">fresh turn</msg>')
})

test('compileGroupProbeContextLayers applies Anthropic cache breakpoints when requested', () => {
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [
      { role: 'user', content: '<msg from="Alice">earlier chatter</msg>' },
      { role: 'assistant', content: 'Staying quiet.' }
    ],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>',
    styleReminder: 'Keep the persona sharp.',
    anthropicCacheBreakpoints: true
  })

  const cacheControlOf = (message: (typeof messages)[number]): unknown =>
    (message.providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined)?.anthropic
      ?.cacheControl

  // BP1: the last system message — the stable per-group prefix ends there.
  const lastSystemIdx = messages.map((m) => m.role).lastIndexOf('system')
  assert.ok(lastSystemIdx >= 0)
  assert.deepEqual(cacheControlOf(messages[lastSystemIdx]!), { type: 'ephemeral' })

  // BP2: the message just before the last (volatile) user message.
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')
  assert.ok(lastUserIdx > 0)
  assert.deepEqual(cacheControlOf(messages[lastUserIdx - 1]!), { type: 'ephemeral' })
})

test('compileGroupProbeContextLayers leaves messages unannotated by default', () => {
  const messages = compileGroupProbeContextLayers({
    stableSystemPrompt: 'Stable group behavior rules.',
    dynamicSystemPrompt: 'You are the group probe.',
    history: [],
    currentTurnContent: '<msg from="Bob">fresh turn</msg>'
  })

  for (const message of messages) {
    assert.equal(message.providerOptions, undefined)
  }
})
