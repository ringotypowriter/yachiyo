import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildGroupReplyInstruction, formatGroupMessages } from './groupContextBuilder.ts'

describe('buildGroupReplyInstruction', () => {
  it('includes base channel reply hint', () => {
    const instruction = buildGroupReplyInstruction({ shouldReply: true, reason: 'test' }, 'Yachiyo')
    assert.ok(instruction.includes('<channel_reply_instruction>'))
    assert.ok(instruction.includes('<group_context>'))
    assert.ok(instruction.includes('Yachiyo'))
  })

  it('includes topic when provided', () => {
    const instruction = buildGroupReplyInstruction(
      { shouldReply: true, topic: 'cooking recipes', reason: 'test' },
      'Yachiyo'
    )
    assert.ok(instruction.includes('cooking recipes'))
  })

  it('includes tone when provided', () => {
    const instruction = buildGroupReplyInstruction(
      { shouldReply: true, tone: 'casual', reason: 'test' },
      'Yachiyo'
    )
    assert.ok(instruction.includes('casual'))
  })

  it('works with minimal decision (no topic/tone)', () => {
    const instruction = buildGroupReplyInstruction({ shouldReply: true, reason: 'test' }, 'Bot')
    assert.ok(!instruction.includes('topic to address'))
    assert.ok(!instruction.includes('Suggested tone'))
  })
})

describe('formatGroupMessages', () => {
  it('labels user messages with sender name', () => {
    const result = formatGroupMessages(
      [
        { senderName: 'Alice', role: 'user', content: 'hello' },
        { senderName: 'Bob', role: 'user', content: 'hi there' }
      ],
      'Yachiyo'
    )
    assert.equal(result, '[Alice] hello\n[Bob] hi there')
  })

  it('labels assistant messages with bot name', () => {
    const result = formatGroupMessages(
      [
        { senderName: 'Alice', role: 'user', content: 'hey' },
        { senderName: null, role: 'assistant', content: 'hello!' }
      ],
      'Yachiyo'
    )
    assert.equal(result, '[Alice] hey\n[Yachiyo] hello!')
  })

  it('preserves bare content for DM messages without sender', () => {
    const result = formatGroupMessages(
      [{ senderName: null, role: 'user', content: 'legacy dm' }],
      'Yachiyo'
    )
    assert.equal(result, 'legacy dm')
  })
})
