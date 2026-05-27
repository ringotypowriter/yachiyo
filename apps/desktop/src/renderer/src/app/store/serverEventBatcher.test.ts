import assert from 'node:assert/strict'
import test from 'node:test'

import type { YachiyoServerEvent } from '../types.ts'
import { createServerEventBatcher } from './serverEventBatcher.ts'

function messageDelta(input: {
  eventId: string
  timestamp: string
  delta: string
}): YachiyoServerEvent {
  return {
    type: 'message.delta',
    eventId: input.eventId,
    timestamp: input.timestamp,
    threadId: 'thread-1',
    runId: 'run-1',
    messageId: 'message-1',
    delta: input.delta
  }
}

function reasoningDelta(input: {
  eventId: string
  timestamp: string
  delta: string
}): YachiyoServerEvent {
  return {
    type: 'message.reasoning.delta',
    eventId: input.eventId,
    timestamp: input.timestamp,
    threadId: 'thread-1',
    runId: 'run-1',
    messageId: 'message-1',
    delta: input.delta
  }
}

function messageCompleted(): YachiyoServerEvent {
  return {
    type: 'message.completed',
    eventId: 'completed-1',
    timestamp: '2026-01-01T00:00:03.000Z',
    threadId: 'thread-1',
    runId: 'run-1',
    message: {
      id: 'message-1',
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Hello world',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  }
}

test('coalesces consecutive message deltas into one frame event', () => {
  const applied: YachiyoServerEvent[] = []
  const frames: Array<() => void> = []
  const batcher = createServerEventBatcher({
    applyEvent: (event) => applied.push(event),
    scheduleFrame: (callback) => {
      frames.push(callback)
      return frames.length
    },
    cancelFrame: () => undefined
  })

  batcher.push(
    messageDelta({
      eventId: 'delta-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      delta: 'Hello '
    })
  )
  batcher.push(
    messageDelta({
      eventId: 'delta-2',
      timestamp: '2026-01-01T00:00:02.000Z',
      delta: 'world'
    })
  )

  assert.equal(applied.length, 0)
  frames[0]!()

  assert.deepEqual(applied, [
    {
      type: 'message.delta',
      eventId: 'delta-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      threadId: 'thread-1',
      runId: 'run-1',
      messageId: 'message-1',
      delta: 'Hello world'
    }
  ])
})

test('flushes pending deltas before non-stream events', () => {
  const applied: YachiyoServerEvent[] = []
  const batcher = createServerEventBatcher({
    applyEvent: (event) => applied.push(event),
    scheduleFrame: () => 1,
    cancelFrame: () => undefined
  })

  batcher.push(
    messageDelta({
      eventId: 'delta-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      delta: 'Hello '
    })
  )
  batcher.push(
    messageDelta({
      eventId: 'delta-2',
      timestamp: '2026-01-01T00:00:02.000Z',
      delta: 'world'
    })
  )
  batcher.push(messageCompleted())

  assert.equal(applied.length, 2)
  assert.equal(applied[0]?.type, 'message.delta')
  assert.equal(applied[0]?.type === 'message.delta' ? applied[0].delta : '', 'Hello world')
  assert.equal(applied[1]?.type, 'message.completed')
})

test('keeps reasoning and text delta ordering while batching consecutive runs', () => {
  const applied: YachiyoServerEvent[] = []
  const batcher = createServerEventBatcher({
    applyEvent: (event) => applied.push(event),
    scheduleFrame: () => 1,
    cancelFrame: () => undefined
  })

  batcher.push(
    reasoningDelta({
      eventId: 'reasoning-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      delta: 'Think '
    })
  )
  batcher.push(
    reasoningDelta({
      eventId: 'reasoning-2',
      timestamp: '2026-01-01T00:00:02.000Z',
      delta: 'first. '
    })
  )
  batcher.push(
    messageDelta({
      eventId: 'delta-1',
      timestamp: '2026-01-01T00:00:03.000Z',
      delta: 'Answer'
    })
  )

  batcher.flush()

  assert.equal(applied.length, 2)
  assert.equal(
    applied[0]?.type === 'message.reasoning.delta' ? applied[0].delta : '',
    'Think first. '
  )
  assert.equal(applied[1]?.type === 'message.delta' ? applied[1].delta : '', 'Answer')
})
