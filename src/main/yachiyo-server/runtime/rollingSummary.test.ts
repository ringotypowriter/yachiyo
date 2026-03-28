import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { MessageRecord } from '../../../shared/yachiyo/protocol.ts'
import { buildRollingSummaryMessages } from './rollingSummary.ts'

function makeMessage(role: 'user' | 'assistant', content: string): MessageRecord {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    threadId: 'thread-1',
    role,
    content,
    status: 'completed',
    createdAt: new Date().toISOString()
  }
}

describe('buildRollingSummaryMessages', () => {
  it('includes the system prompt and history', () => {
    const messages = buildRollingSummaryMessages({
      history: [
        makeMessage('user', 'What is the weather?'),
        makeMessage('assistant', 'It is sunny today.')
      ]
    })

    // Should have system messages + history + the summary prompt
    assert.ok(messages.length >= 3, 'should have system + history + prompt messages')

    // Last message should be the summary prompt
    const lastMsg = messages[messages.length - 1]
    assert.equal(lastMsg.role, 'user')
    assert.ok((lastMsg.content as string).includes('Summarize'))
  })

  it('includes user document content when provided', () => {
    const messages = buildRollingSummaryMessages({
      history: [makeMessage('user', 'Hello')],
      userDocumentContent: 'The user prefers Japanese.'
    })

    const systemContent = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content as string)
      .join(' ')

    assert.ok(systemContent.includes('Japanese'), 'should include user document content')
  })

  it('uses visibleReply for assistant messages when available', () => {
    const assistantMsg = makeMessage('assistant', 'Raw <reply>Clean reply</reply> content')
    assistantMsg.visibleReply = 'Clean reply'

    const messages = buildRollingSummaryMessages({
      history: [makeMessage('user', 'Hello'), assistantMsg]
    })

    // Find the assistant content in history — should be the visible reply, not raw
    const historyAssistant = messages.find(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content === 'Clean reply'
    )
    assert.ok(historyAssistant, 'should use visibleReply for assistant content')
  })

  it('handles empty history gracefully', () => {
    const messages = buildRollingSummaryMessages({ history: [] })

    const lastMsg = messages[messages.length - 1]
    assert.ok(
      (lastMsg.content as string).includes('barely started'),
      'should note conversation barely started'
    )
  })

  it('summary prompt excludes internal artifacts', () => {
    const messages = buildRollingSummaryMessages({
      history: [makeMessage('user', 'Test')]
    })

    const promptContent = messages[messages.length - 1].content as string
    assert.ok(promptContent.includes('Do NOT include'))
    assert.ok(promptContent.includes('Tool calls'))
    assert.ok(promptContent.includes('File paths'))
  })
})
