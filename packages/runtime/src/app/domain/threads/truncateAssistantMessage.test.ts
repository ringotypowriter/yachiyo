import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MessageRecord } from '@yachiyo/shared/protocol'
import { truncateAssistantMessageBeforeToolCall } from './truncateAssistantMessage.ts'

function assistantMessage(overrides: Partial<MessageRecord>): MessageRecord {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    role: 'assistant',
    content: '',
    status: 'completed',
    createdAt: '2026-07-18T00:00:00.000Z',
    ...overrides
  }
}

type ResponsePart = Record<string, unknown>
type ResponseMessage = { role: string; content: unknown }

const text = (value: string): ResponsePart => ({ type: 'text', text: value })
const reasoning = (value: string): ResponsePart => ({ type: 'reasoning', text: value })
const toolCall = (id: string, toolName = 'askUser'): ResponsePart => ({
  type: 'tool-call',
  toolCallId: id,
  toolName,
  input: {}
})
const toolResult = (id: string, toolName = 'askUser'): ResponseMessage => ({
  role: 'tool',
  content: [
    { type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value: 'ok' } }
  ]
})
const assistant = (...parts: unknown[]): ResponseMessage => ({ role: 'assistant', content: parts })

describe('truncateAssistantMessageBeforeToolCall', () => {
  it('truncates a mid-run askUser call and drops everything after it', () => {
    const message = assistantMessage({
      content: 'intro middle tail',
      textBlocks: [
        { id: 'tb-1', content: 'intro ', createdAt: '2026-07-18T00:00:01.000Z' },
        { id: 'tb-2', content: 'middle ', createdAt: '2026-07-18T00:00:02.000Z' },
        { id: 'tb-3', content: 'tail', createdAt: '2026-07-18T00:00:03.000Z' }
      ],
      responseMessages: [
        assistant(text('intro '), toolCall('call-read', 'readFile')),
        toolResult('call-read', 'readFile'),
        assistant(text('middle '), toolCall('call-ask')),
        toolResult('call-ask'),
        assistant(text('tail'))
      ]
    })

    const result = truncateAssistantMessageBeforeToolCall(message, 'call-ask')

    assert.equal(result.kind, 'truncated')
    assert(result.kind === 'truncated')
    assert.equal(result.message.content, 'intro middle ')
    assert.deepEqual(result.message.responseMessages, [
      assistant(text('intro '), toolCall('call-read', 'readFile')),
      toolResult('call-read', 'readFile'),
      assistant(text('middle '))
    ])
    assert.deepEqual(result.message.textBlocks, [
      { id: 'tb-1', content: 'intro ', createdAt: '2026-07-18T00:00:01.000Z' },
      { id: 'tb-2', content: 'middle ', createdAt: '2026-07-18T00:00:02.000Z' }
    ])
  })

  it('returns empty when the askUser call is the very first part', () => {
    const message = assistantMessage({
      content: 'answer follow-up',
      responseMessages: [
        assistant(toolCall('call-ask')),
        toolResult('call-ask'),
        assistant(text('answer follow-up'))
      ]
    })

    assert.deepEqual(truncateAssistantMessageBeforeToolCall(message, 'call-ask'), { kind: 'empty' })
  })

  it('keeps earlier assistant text from a prior response message', () => {
    const message = assistantMessage({
      content: 'thinking done. more',
      responseMessages: [
        assistant(text('thinking done. '), toolCall('call-read', 'readFile')),
        toolResult('call-read', 'readFile'),
        assistant(toolCall('call-ask')),
        toolResult('call-ask'),
        assistant(text('more'))
      ]
    })

    const result = truncateAssistantMessageBeforeToolCall(message, 'call-ask')

    assert(result.kind === 'truncated')
    assert.equal(result.message.content, 'thinking done. ')
    assert.deepEqual(result.message.responseMessages, [
      assistant(text('thinking done. '), toolCall('call-read', 'readFile')),
      toolResult('call-read', 'readFile')
    ])
  })

  it('drops sibling parallel tool calls in the cut message to avoid orphaned tool_use', () => {
    const message = assistantMessage({
      content: 'checking ',
      responseMessages: [
        assistant(text('checking '), toolCall('call-read', 'readFile'), toolCall('call-ask')),
        toolResult('call-read', 'readFile'),
        toolResult('call-ask')
      ]
    })

    const result = truncateAssistantMessageBeforeToolCall(message, 'call-ask')

    assert(result.kind === 'truncated')
    assert.deepEqual(result.message.responseMessages, [assistant(text('checking '))])
  })

  it('trims trailing reasoning that led into the removed call but keeps mid-message reasoning', () => {
    const trailing = assistantMessage({
      content: 'partial',
      responseMessages: [
        assistant(text('partial'), reasoning('should I ask?'), toolCall('call-ask'))
      ]
    })
    const trailingResult = truncateAssistantMessageBeforeToolCall(trailing, 'call-ask')
    assert(trailingResult.kind === 'truncated')
    assert.deepEqual(trailingResult.message.responseMessages, [assistant(text('partial'))])
    assert.equal(trailingResult.message.reasoning, undefined)

    const leading = assistantMessage({
      content: 'partial',
      responseMessages: [assistant(reasoning('warm-up'), text('partial'), toolCall('call-ask'))]
    })
    const leadingResult = truncateAssistantMessageBeforeToolCall(leading, 'call-ask')
    assert(leadingResult.kind === 'truncated')
    assert.deepEqual(leadingResult.message.responseMessages, [
      assistant(reasoning('warm-up'), text('partial'))
    ])
    assert.equal(leadingResult.message.reasoning, 'warm-up')
  })

  it('returns empty when only reasoning remains before the call', () => {
    const message = assistantMessage({
      content: '',
      reasoning: 'hmm',
      responseMessages: [assistant(reasoning('hmm'), toolCall('call-ask'))]
    })

    assert.deepEqual(truncateAssistantMessageBeforeToolCall(message, 'call-ask'), { kind: 'empty' })
  })

  it('returns not-found for an unknown toolCallId or missing responseMessages', () => {
    const message = assistantMessage({
      content: 'hi',
      responseMessages: [assistant(text('hi'), toolCall('call-ask'))]
    })

    assert.deepEqual(truncateAssistantMessageBeforeToolCall(message, 'call-other'), {
      kind: 'not-found'
    })
    assert.deepEqual(
      truncateAssistantMessageBeforeToolCall(assistantMessage({ content: 'hi' }), 'call-ask'),
      { kind: 'not-found' }
    )
  })

  it('slices the text block straddling the cut and drops later blocks', () => {
    const message = assistantMessage({
      content: 'alpha beta gamma',
      textBlocks: [
        { id: 'tb-1', content: 'alpha ', createdAt: '2026-07-18T00:00:01.000Z' },
        { id: 'tb-2', content: 'beta gamma', createdAt: '2026-07-18T00:00:02.000Z' }
      ],
      responseMessages: [
        assistant(text('alpha beta '), toolCall('call-ask')),
        toolResult('call-ask'),
        assistant(text('gamma'))
      ]
    })

    const result = truncateAssistantMessageBeforeToolCall(message, 'call-ask')

    assert(result.kind === 'truncated')
    assert.equal(result.message.content, 'alpha beta ')
    assert.deepEqual(result.message.textBlocks, [
      { id: 'tb-1', content: 'alpha ', createdAt: '2026-07-18T00:00:01.000Z' },
      { id: 'tb-2', content: 'beta ', createdAt: '2026-07-18T00:00:02.000Z' }
    ])
  })

  it('keeps string-content assistant messages before the cut whole', () => {
    const message = assistantMessage({
      content: 'plain text lead-in follow',
      responseMessages: [
        { role: 'assistant', content: 'plain text lead-in ' },
        assistant(text('follow'), toolCall('call-ask'))
      ]
    })

    const result = truncateAssistantMessageBeforeToolCall(message, 'call-ask')

    assert(result.kind === 'truncated')
    assert.equal(result.message.content, 'plain text lead-in follow')
    assert.deepEqual(result.message.responseMessages, [
      { role: 'assistant', content: 'plain text lead-in ' },
      assistant(text('follow'))
    ])
  })

  it('does not mutate the input message', () => {
    const message = assistantMessage({
      content: 'intro tail',
      textBlocks: [
        { id: 'tb-1', content: 'intro ', createdAt: '2026-07-18T00:00:01.000Z' },
        { id: 'tb-2', content: 'tail', createdAt: '2026-07-18T00:00:02.000Z' }
      ],
      responseMessages: [
        assistant(text('intro '), toolCall('call-ask')),
        toolResult('call-ask'),
        assistant(text('tail'))
      ]
    })
    const snapshot = structuredClone(message)

    truncateAssistantMessageBeforeToolCall(message, 'call-ask')

    assert.deepEqual(message, snapshot)
  })
})
