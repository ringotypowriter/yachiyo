import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFindMatches } from './threadFindBar.ts'
import type { Message, ToolCall } from '@renderer/app/types'

function makeMessage(overrides: Partial<Message> & { id: string }): Message {
  return {
    threadId: 'thread-1',
    role: 'user',
    content: '',
    status: 'done',
    createdAt: new Date().toISOString(),
    ...overrides
  } as Message
}

function makeToolCall(overrides: Partial<ToolCall> & { id: string }): ToolCall {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    toolName: 'bash',
    status: 'done',
    inputSummary: '',
    startedAt: new Date().toISOString(),
    ...overrides
  } as ToolCall
}

describe('buildFindMatches', () => {
  it('returns empty array for empty query', () => {
    const msgs = [makeMessage({ id: 'm1', content: 'hello world' })]
    assert.deepEqual(buildFindMatches(msgs, [], ''), [])
  })

  it('returns empty array for query shorter than 2 chars', () => {
    const msgs = [makeMessage({ id: 'm1', content: 'hello world' })]
    assert.deepEqual(buildFindMatches(msgs, [], 'h'), [])
  })

  it('matches user message by content', () => {
    const msgs = [makeMessage({ id: 'm1', content: 'hello world' })]
    assert.deepEqual(buildFindMatches(msgs, [], 'hello'), [{ messageId: 'm1' }])
  })

  it('matches assistant message by content', () => {
    const msgs = [makeMessage({ id: 'm1', role: 'assistant', content: 'The answer is 42' })]
    assert.deepEqual(buildFindMatches(msgs, [], 'answer'), [{ messageId: 'm1' }])
  })

  it('prefers textBlocks over content when textBlocks present', () => {
    const msgs = [
      makeMessage({
        id: 'm1',
        content: 'raw content',
        textBlocks: [{ id: 'b1', content: 'block text here', createdAt: new Date().toISOString() }]
      })
    ]
    // 'block' matches textBlocks but not content
    assert.deepEqual(buildFindMatches(msgs, [], 'block'), [{ messageId: 'm1' }])
    // 'raw content' is not searched when textBlocks exist
    assert.deepEqual(buildFindMatches(msgs, [], 'raw content'), [])
  })

  it('is case-insensitive', () => {
    const msgs = [makeMessage({ id: 'm1', content: 'Hello World' })]
    assert.deepEqual(buildFindMatches(msgs, [], 'HELLO'), [{ messageId: 'm1' }])
  })

  it('matches tool call by inputSummary', () => {
    const tc = makeToolCall({ id: 'tc1', assistantMessageId: 'm2', inputSummary: 'run tests' })
    assert.deepEqual(buildFindMatches([], [tc], 'tests'), [{ messageId: 'm2' }])
  })

  it('matches tool call by outputSummary', () => {
    const tc = makeToolCall({
      id: 'tc1',
      assistantMessageId: 'm2',
      inputSummary: 'ls',
      outputSummary: 'file listing result'
    })
    assert.deepEqual(buildFindMatches([], [tc], 'listing'), [{ messageId: 'm2' }])
  })

  it('uses requestMessageId when assistantMessageId is absent', () => {
    const tc = makeToolCall({ id: 'tc1', requestMessageId: 'm3', inputSummary: 'search query' })
    assert.deepEqual(buildFindMatches([], [tc], 'search'), [{ messageId: 'm3' }])
  })

  it('skips tool call with no anchor', () => {
    const tc = makeToolCall({ id: 'tc1', inputSummary: 'orphaned call' })
    assert.deepEqual(buildFindMatches([], [tc], 'orphaned'), [])
  })

  it('deduplicates when message content and tool call share the same anchor', () => {
    const msg = makeMessage({ id: 'm1', content: 'hello world' })
    const tc = makeToolCall({ id: 'tc1', assistantMessageId: 'm1', inputSummary: 'hello cmd' })
    const result = buildFindMatches([msg], [tc], 'hello')
    assert.deepEqual(result, [{ messageId: 'm1' }])
  })

  it('returns no match when query does not match anything', () => {
    const msgs = [makeMessage({ id: 'm1', content: 'hello world' })]
    assert.deepEqual(buildFindMatches(msgs, [], 'zzznomatch'), [])
  })
})
