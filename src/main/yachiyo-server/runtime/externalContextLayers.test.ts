import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildExternalAgentInstructions,
  compileExternalContextLayers
} from './externalContextLayers.ts'

describe('buildExternalAgentInstructions', () => {
  it('lists only the provided tools', () => {
    const result = buildExternalAgentInstructions({
      enabledTools: ['read', 'grep', 'webSearch']
    })

    assert.ok(result.includes('read'))
    assert.ok(result.includes('grep'))
    assert.ok(result.includes('webSearch'))
    assert.ok(!result.includes('bash'))
    assert.ok(!result.includes('edit'))
    assert.ok(!result.includes('write'))
  })

  it('does not include local-agent assumptions', () => {
    const result = buildExternalAgentInstructions({
      enabledTools: ['read', 'grep', 'glob', 'webRead', 'webSearch']
    })

    assert.ok(!result.includes('YOLO'))
    assert.ok(!result.includes('local agent'))
    assert.ok(!result.includes('USER.md'))
    assert.ok(!result.includes('SOUL.md'))
    assert.ok(!result.includes('workspace'))
    assert.ok(!result.includes('subagent'))
    assert.ok(!result.includes('skill'))
  })

  it('handles no tools gracefully', () => {
    const result = buildExternalAgentInstructions({ enabledTools: [] })

    assert.ok(result.includes('No tools are available'))
    assert.ok(!result.includes('Available tools:'))
  })

  it('includes anti-hallucination rule', () => {
    const result = buildExternalAgentInstructions({ enabledTools: ['read'] })

    assert.ok(result.includes('Never invent'))
  })
})

describe('compileExternalContextLayers', () => {
  const basePersona = 'You are Yachiyo.'

  it('produces a single consolidated system message', () => {
    const messages = compileExternalContextLayers({
      personality: { basePersona },
      soul: { content: 'Soul content' },
      user: { content: 'User content' },
      executionContract: 'Available tools: read.',
      channelInstruction: '<channel_reply_instruction>Use reply tags.</channel_reply_instruction>',
      history: []
    })

    const systemMessages = messages.filter((m) => m.role === 'system')
    assert.equal(systemMessages.length, 1, 'should consolidate into a single system message')

    const content = systemMessages[0].content as string
    assert.ok(content.includes('Yachiyo'), 'should include personality')
    assert.ok(content.includes('Available tools: read'), 'should include execution contract')
    assert.ok(content.includes('reply tags'), 'should include channel instruction')
  })

  it('does not include skills layer', () => {
    const messages = compileExternalContextLayers({
      personality: { basePersona },
      executionContract: '',
      channelInstruction: '',
      history: []
    })

    const content = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ')
    assert.ok(!content.includes('Skill'), 'should not contain skills references')
  })

  it('includes rolling summary as a user message before history', () => {
    const messages = compileExternalContextLayers({
      personality: { basePersona },
      executionContract: '',
      channelInstruction: '',
      rollingSummary: 'We were discussing weather patterns.',
      history: [
        { role: 'user', content: 'What about today?' },
        { role: 'assistant', content: 'Sunny!' }
      ]
    })

    const userMessages = messages.filter((m) => m.role === 'user')
    const summaryMsg = userMessages.find(
      (m) => typeof m.content === 'string' && m.content.includes('conversation_summary')
    )
    assert.ok(summaryMsg, 'should include rolling summary')
    assert.ok(
      (summaryMsg!.content as string).includes('weather patterns'),
      'summary should contain the actual content'
    )

    // Summary should come before history
    const summaryIndex = messages.indexOf(summaryMsg!)
    const firstHistoryUser = messages.findIndex(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('today')
    )
    assert.ok(summaryIndex < firstHistoryUser, 'summary should precede history')
  })

  it('places hint and memory before the last user message', () => {
    const messages = compileExternalContextLayers({
      personality: { basePersona },
      executionContract: '',
      channelInstruction: '',
      history: [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Reply' },
        { role: 'user', content: 'Second message' }
      ],
      hint: { reminder: '<reminder>Current time: 12:00</reminder>' },
      memory: { entries: ['User prefers concise answers'] }
    })

    const userMsgContents = messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))

    // The hint/memory should appear just before "Second message"
    const hintIndex = userMsgContents.findIndex((c) => c.includes('Current time'))
    const lastQueryIndex = userMsgContents.findIndex((c) => c.includes('Second message'))
    assert.ok(hintIndex >= 0, 'hint should be present')
    assert.ok(lastQueryIndex >= 0, 'last query should be present')
    assert.ok(hintIndex < lastQueryIndex, 'hint should come before the last user message')
  })

  it('omits rolling summary when not provided', () => {
    const messages = compileExternalContextLayers({
      personality: { basePersona },
      executionContract: '',
      channelInstruction: '',
      history: [{ role: 'user', content: 'Hello' }]
    })

    const summaryMsg = messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('conversation_summary')
    )
    assert.equal(summaryMsg, undefined, 'should not include summary when not provided')
  })

  it('preserves full history including responseMessages for cache stability', () => {
    const toolMessages = [
      { role: 'assistant', content: 'Using tool...' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', output: 'result' }] }
    ]

    const messages = compileExternalContextLayers({
      personality: { basePersona },
      executionContract: '',
      channelInstruction: '',
      history: [
        {
          role: 'user',
          content: 'Search for something'
        },
        {
          role: 'assistant',
          content: 'Found results.',
          responseMessages: toolMessages
        }
      ]
    })

    // The assistant turn with responseMessages should be expanded to the structured messages
    const assistantMessages = messages.filter((m) => m.role === 'assistant')
    assert.ok(assistantMessages.length > 0, 'should have assistant messages from responseMessages')
  })
})
