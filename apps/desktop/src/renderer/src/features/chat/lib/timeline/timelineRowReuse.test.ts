import assert from 'node:assert/strict'
import test from 'node:test'

import { reuseTimelineRows } from './timelineRowReuse.ts'

interface FakeRow {
  kind: string
  key: string
  [prop: string]: unknown
}

function makeMessage(id: string, content: string): { id: string; content: string } {
  return { id, content }
}

test('reuseTimelineRows', async (t) => {
  await t.test('reuses the previous row object when nothing changed', () => {
    const message = makeMessage('m1', 'hello')
    const prev: FakeRow[] = [
      { kind: 'group-user', key: 'user:m1', group: { userMessage: message, branches: [] } }
    ]
    const next: FakeRow[] = [
      { kind: 'group-user', key: 'user:m1', group: { userMessage: message, branches: [] } }
    ]

    const result = reuseTimelineRows(prev as never, next as never) as unknown as FakeRow[]
    assert.equal(result[0], prev[0])
  })

  await t.test('keeps the new row when a nested value changed', () => {
    const prev: FakeRow[] = [
      {
        kind: 'text',
        key: 'text:m1',
        message: makeMessage('m1', 'partial'),
        isStreaming: true
      }
    ]
    const next: FakeRow[] = [
      {
        kind: 'text',
        key: 'text:m1',
        message: makeMessage('m1', 'partial plus more'),
        isStreaming: true
      }
    ]

    const result = reuseTimelineRows(prev as never, next as never) as unknown as FakeRow[]
    assert.equal(result[0], next[0])
  })

  await t.test('reuses unchanged rows while adopting changed ones', () => {
    const stableMessage = makeMessage('m1', 'done')
    const prev: FakeRow[] = [
      { kind: 'text', key: 'text:m1', message: stableMessage, isStreaming: false },
      { kind: 'text', key: 'text:m2', message: makeMessage('m2', 'streaming'), isStreaming: true }
    ]
    const next: FakeRow[] = [
      { kind: 'text', key: 'text:m1', message: stableMessage, isStreaming: false },
      { kind: 'text', key: 'text:m2', message: makeMessage('m2', 'streaming++'), isStreaming: true }
    ]

    const result = reuseTimelineRows(prev as never, next as never) as unknown as FakeRow[]
    assert.equal(result[0], prev[0])
    assert.equal(result[1], next[1])
  })

  await t.test('treats added and removed keys as changes', () => {
    const prev: FakeRow[] = [{ kind: 'text', key: 'text:m1', flag: true }]
    const next: FakeRow[] = [
      { kind: 'text', key: 'text:m1', flag: true },
      { kind: 'text', key: 'text:m2', flag: false }
    ]

    const result = reuseTimelineRows(prev as never, next as never) as unknown as FakeRow[]
    assert.equal(result.length, 2)
    assert.equal(result[0], prev[0])
    assert.equal(result[1], next[1])
  })

  await t.test('compares arrays element-wise instead of by reference', () => {
    const toolCall = { id: 'tc1', status: 'completed' }
    const prev: FakeRow[] = [{ kind: 'tools', key: 'tools:1', toolCalls: [toolCall] }]
    const next: FakeRow[] = [{ kind: 'tools', key: 'tools:1', toolCalls: [toolCall] }]

    const result = reuseTimelineRows(prev as never, next as never) as unknown as FakeRow[]
    assert.equal(result[0], prev[0])
  })

  await t.test('returns the previous array instance when every row was reused', () => {
    const message = makeMessage('m1', 'done')
    const prev: FakeRow[] = [{ kind: 'text', key: 'text:m1', message, isStreaming: false }]
    const next: FakeRow[] = [{ kind: 'text', key: 'text:m1', message, isStreaming: false }]

    const result = reuseTimelineRows(prev as never, next as never)
    assert.equal(result, prev as never)
  })
})
