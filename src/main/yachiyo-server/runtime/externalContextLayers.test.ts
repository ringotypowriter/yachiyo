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
    // 'write' may appear in update_profile instructions (managing USER.md), that's fine
  })

  it('does not include local-agent assumptions', () => {
    const result = buildExternalAgentInstructions({
      enabledTools: ['read', 'grep', 'glob', 'webRead', 'webSearch']
    })

    assert.ok(!result.includes('YOLO'))
    assert.ok(!result.includes('local agent'))
    // USER.md is now intentionally mentioned via the update_profile tool
    assert.ok(!result.includes('SOUL.md'))
    assert.ok(!result.includes('subagent'))
    assert.ok(!result.includes('skill'))
  })

  it('still documents update_profile when core tools are empty', () => {
    const result = buildExternalAgentInstructions({ enabledTools: [] })

    assert.ok(!result.includes('Available tools:'))
    assert.ok(result.includes('update_profile'))
  })

  it('includes conversational role definition', () => {
    const result = buildExternalAgentInstructions({ enabledTools: ['read'] })

    assert.ok(result.includes('conversational companion'))
    assert.ok(result.includes('not coding assistant'))
  })

  it('documents the update_profile tool with upsert and remove operations', () => {
    const result = buildExternalAgentInstructions({ enabledTools: ['read'] })

    assert.ok(result.includes('update_profile tool for managing the user profile (USER.md)'))
    assert.ok(result.includes('operation "upsert"'))
    assert.ok(result.includes('operation "remove"'))
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

  it('merges hint and memory into the last user message', () => {
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

    // hint and memory should be merged into the last user message
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
    assert.ok(lastUserMsg, 'should have a user message')
    const content = lastUserMsg.content as string
    assert.ok(content.includes('Second message'), 'should contain the original query')
    assert.ok(content.includes('Current time'), 'should contain the hint')
    assert.ok(content.includes('User prefers concise answers'), 'should contain the memory')

    // First user message should be unmodified
    const firstUserMsg = messages.find((m) => m.role === 'user')
    assert.equal(firstUserMsg?.content, 'First message')
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
