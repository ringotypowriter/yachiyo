import assert from 'node:assert/strict'
import test from 'node:test'

import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import type { RemotePush } from '@yachiyo/shared/remote/events'
import type { RemoteThreadSummary } from '@yachiyo/shared/remote/projections'

import { RemoteEventHub, type RemoteEventSubscription } from './remoteEventHub.ts'

type LooseEvent = { type: string } & Record<string, unknown>

function createSource(): {
  emit: (event: LooseEvent) => void
  subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
  listenerCount: () => number
} {
  const listeners = new Set<(event: YachiyoServerEvent) => void>()
  return {
    emit: (event) =>
      listeners.forEach((listener) =>
        listener({
          eventId: 'e',
          timestamp: '2026-09-22T00:00:00.000Z',
          ...event
        } as unknown as YachiyoServerEvent)
      ),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listenerCount: () => listeners.size
  }
}

function summary(threadId: string): RemoteThreadSummary {
  return {
    id: threadId,
    title: threadId,
    starred: false,
    updatedAt: '2026-09-22T00:00:00.000Z',
    needsAttention: false,
    capabilities: {
      canRetry: true,
      canCreateBranch: true,
      canSelectReplyBranch: true,
      canEdit: true,
      canSend: true
    }
  }
}

function createHub(options: { bufferLimit?: number; now?: () => number } = {}): {
  hub: RemoteEventHub
  source: ReturnType<typeof createSource>
} {
  const source = createSource()
  const hub = new RemoteEventHub({
    subscribe: source.subscribe,
    getThreadSummary: async (threadId) => summary(threadId),
    createEpoch: () => 'epoch-1',
    coalesceMs: 60_000,
    ...options
  })
  hub.start()
  return { hub, source }
}

function collect(
  hub: RemoteEventHub,
  threads: string[] = []
): { pushes: RemotePush[]; subscription: RemoteEventSubscription } {
  const pushes: RemotePush[] = []
  const subscription = hub.attach((push) => pushes.push(push))
  subscription.setThreads(threads)
  return { pushes, subscription }
}

const delta = (messageId: string, text: string): LooseEvent => ({
  type: 'message.delta',
  threadId: 't1',
  runId: 'r1',
  messageId,
  delta: text
})

test('text deltas are merged per message and flushed before the next ordered event', () => {
  const { hub, source } = createHub()
  const { pushes, subscription } = collect(hub, ['t1'])
  subscription.resume()

  source.emit(delta('m1', 'Hel'))
  source.emit(delta('m1', 'lo'))
  source.emit(delta('m1', ' there'))
  assert.equal(pushes.length, 0, 'deltas wait for the coalescing window')

  source.emit({
    type: 'tool.updated',
    threadId: 't1',
    runId: 'r1',
    toolCall: {
      id: 'tool-1',
      threadId: 't1',
      toolName: 'bash',
      status: 'running',
      inputSummary: 'ls',
      startedAt: '2026-09-22T00:00:00.000Z'
    }
  })

  assert.deepEqual(
    pushes.map((push) => (push.type === 'event' ? [push.seq, push.event.type] : [])),
    [
      [1, 'message.delta'],
      [2, 'tool.updated']
    ]
  )
  const first = pushes[0]
  assert.ok(first?.type === 'event' && first.event.type === 'message.delta')
  assert.equal(first.event.delta, 'Hello there')
  hub.stop()
})

test('thread-scope events reach only subscribed connections; inbox events reach all', () => {
  const { hub, source } = createHub()
  const watching = collect(hub, ['t1'])
  const inboxOnly = collect(hub)
  watching.subscription.resume()
  inboxOnly.subscription.resume()

  source.emit({ type: 'message.started', threadId: 't1', runId: 'r1', messageId: 'm1' })
  source.emit({ type: 'run.completed', threadId: 't1', runId: 'r1' })

  assert.deepEqual(
    watching.pushes.map((push) => push.type === 'event' && push.event.type),
    ['message.started', 'run.status']
  )
  assert.deepEqual(
    inboxOnly.pushes.map((push) => push.type === 'event' && push.event.type),
    ['run.status']
  )
  hub.stop()
})

test('resume replays buffered events after the given seq', () => {
  const { hub, source } = createHub()
  for (let index = 0; index < 5; index += 1) {
    source.emit({ type: 'run.created', threadId: 't1', runId: `r${index}` })
  }

  const { pushes, subscription } = collect(hub)
  const result = subscription.resume({ epoch: 'epoch-1', seq: 2 })

  assert.deepEqual(result, { epoch: 'epoch-1', headSeq: 5, resumed: true })
  assert.deepEqual(
    pushes.map((push) => push.type === 'event' && push.seq),
    [3, 4, 5]
  )

  source.emit({ type: 'run.created', threadId: 't1', runId: 'live' })
  assert.equal(pushes.at(-1)?.type === 'event' && pushes.at(-1)?.seq, 6)
  hub.stop()
})

test('resume asks for a resync when the seq fell out of the buffer or the epoch changed', () => {
  const { hub, source } = createHub({ bufferLimit: 3 })
  for (let index = 0; index < 6; index += 1) {
    source.emit({ type: 'run.created', threadId: 't1', runId: `r${index}` })
  }

  const outOfBuffer = collect(hub)
  assert.deepEqual(outOfBuffer.subscription.resume({ epoch: 'epoch-1', seq: 1 }), {
    epoch: 'epoch-1',
    headSeq: 6,
    resumed: false
  })
  assert.equal(outOfBuffer.pushes.length, 0)

  const edge = collect(hub)
  assert.equal(edge.subscription.resume({ epoch: 'epoch-1', seq: 3 }).resumed, true)
  assert.deepEqual(
    edge.pushes.map((push) => push.type === 'event' && push.seq),
    [4, 5, 6]
  )

  const otherEpoch = collect(hub)
  assert.equal(otherEpoch.subscription.resume({ epoch: 'epoch-0', seq: 5 }).resumed, false)
  assert.equal(collect(hub).subscription.resume({ epoch: 'epoch-1', seq: 7 }).resumed, false)
  hub.stop()
})

test('buffered events older than the retention window are not replayed', () => {
  let now = 0
  const { hub, source } = createHub({ now: () => now })
  source.emit({ type: 'run.created', threadId: 't1', runId: 'old' })
  now = 6 * 60 * 1000
  source.emit({ type: 'run.created', threadId: 't1', runId: 'new' })

  const { subscription } = collect(hub)
  assert.equal(subscription.resume({ epoch: 'epoch-1', seq: 0 }).resumed, false)
  assert.equal(collect(hub).subscription.resume({ epoch: 'epoch-1', seq: 1 }).resumed, true)
  hub.stop()
})

test('settings events only surface the appearance, never provider settings', () => {
  const { hub, source } = createHub()
  const { pushes, subscription } = collect(hub)
  subscription.resume()

  const settingsEvent = {
    type: 'settings.updated',
    config: {
      providers: [{ name: 'p', apiKey: 'sk-hub-canary', baseUrl: 'https://x', modelList: {} }],
      general: { themeId: 'aoba', themeAppearance: 'dark' }
    },
    settings: { apiKey: 'sk-hub-canary' }
  } as unknown as YachiyoServerEvent
  source.emit(settingsEvent as unknown as LooseEvent)
  source.emit(settingsEvent as unknown as LooseEvent)

  assert.equal(JSON.stringify(pushes).includes('sk-hub-canary'), false)
  assert.deepEqual(
    pushes.map((push) => push.type === 'event' && push.event),
    [{ type: 'appearance.changed', appearance: { themeId: 'aoba', themeAppearance: 'dark' } }]
  )
  hub.stop()
})

test('thread changes become summaries fetched after the coalescing window', async () => {
  const { hub, source } = createHub()
  const { pushes, subscription } = collect(hub)
  subscription.resume()

  source.emit({ type: 'thread.updated', threadId: 't9' })
  source.emit({ type: 'thread.updated', threadId: 't9' })
  hub.flush()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    pushes.map((push) => push.type === 'event' && push.event),
    [{ type: 'thread.summary', threadId: 't9', summary: summary('t9') }]
  )
  hub.stop()
})

test('stopping the hub releases the server subscription', () => {
  const { hub, source } = createHub()
  assert.equal(source.listenerCount(), 1)
  hub.stop()
  assert.equal(source.listenerCount(), 0)
})
