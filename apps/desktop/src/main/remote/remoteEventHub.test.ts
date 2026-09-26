import assert from 'node:assert/strict'
import test from 'node:test'

import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import type { RemotePush } from '@yachiyo/shared/remote/events'
import type { RemoteThreadSummary } from '@yachiyo/shared/remote/projections'

import {
  compactReplay,
  RemoteEventHub,
  type RemoteEventHubOptions,
  type RemoteEventHubPersistence,
  type RemoteEventHubState,
  type RemoteEventSubscription
} from './remoteEventHub.ts'

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

function createHub(options: Partial<RemoteEventHubOptions> = {}): {
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
  threads: string[] = [],
  options: { batch?: boolean } = {}
): { pushes: RemotePush[]; subscription: RemoteEventSubscription } {
  const pushes: RemotePush[] = []
  const subscription = hub.attach((push) => pushes.push(push), options)
  subscription.setThreads(threads)
  return { pushes, subscription }
}

/**
 * A hub with an attached (not yet subscribed) phone and no summaries, so run events are
 * numbered contiguously: summaries are neither deferred nor pushed.
 */
function createQuietHub(options: Partial<RemoteEventHubOptions> = {}): {
  hub: RemoteEventHub
  source: ReturnType<typeof createSource>
} {
  const created = createHub({ getThreadSummary: async () => null, ...options })
  created.hub.attach(() => undefined)
  return created
}

/** What the connection does: subscribe, send the response, then start delivery. */
async function subscribe(
  subscription: RemoteEventSubscription,
  from?: { epoch: string; seq: number }
): Promise<{ epoch: string; headSeq: number; resumed: boolean }> {
  const result = await subscription.resume(from)
  subscription.startDelivery()
  return result
}

/** Seqs and event types of `event` and `batch` pushes, in delivery order. */
function flat(pushes: RemotePush[]): Array<[number, string]> {
  return pushes.flatMap((push): Array<[number, string]> => {
    if (push.type === 'event') return [[push.seq, push.event.type]]
    if (push.type === 'batch') return push.items.map((item) => [item.seq, item.event.type])
    return []
  })
}

function events(pushes: RemotePush[]): Array<Record<string, unknown>> {
  return pushes.flatMap((push) => {
    if (push.type === 'event') return [push.event as unknown as Record<string, unknown>]
    if (push.type === 'batch') {
      return push.items.map((item) => item.event as unknown as Record<string, unknown>)
    }
    return []
  })
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function toolUpdate(id: string, status: string, output = ''): LooseEvent {
  return {
    type: 'tool.updated',
    threadId: 't1',
    runId: 'r1',
    toolCall: {
      id,
      threadId: 't1',
      runId: 'r1',
      toolName: 'bash',
      status,
      inputSummary: 'pnpm test',
      outputSummary: output || undefined,
      startedAt: '2026-09-22T00:00:00.000Z'
    }
  }
}

function memoryPersistence(): RemoteEventHubPersistence & {
  saved: { clean: boolean; state?: RemoteEventHubState }
} {
  const saved: { clean: boolean; state?: RemoteEventHubState } = { clean: false }
  return {
    saved,
    open() {
      const restored = saved.clean && saved.state ? structuredClone(saved.state) : null
      saved.clean = false
      return restored
    },
    close(state) {
      saved.clean = true
      saved.state = structuredClone(state)
    }
  }
}

const delta = (messageId: string, text: string): LooseEvent => ({
  type: 'message.delta',
  threadId: 't1',
  runId: 'r1',
  messageId,
  delta: text
})

test('text deltas are merged per message and flushed before the next ordered event', async () => {
  const { hub, source } = createHub()
  const { pushes, subscription } = collect(hub, ['t1'])
  await subscribe(subscription)

  source.emit(delta('m1', 'Hel'))
  source.emit(delta('m1', 'lo'))
  source.emit(delta('m1', ' there'))
  assert.equal(pushes.length, 0, 'deltas wait for the coalescing window')

  source.emit(toolUpdate('tool-1', 'completed'))

  assert.deepEqual(flat(pushes), [
    [1, 'message.delta'],
    [2, 'tool.updated']
  ])
  const first = pushes[0]
  assert.ok(first?.type === 'event' && first.event.type === 'message.delta')
  assert.equal(first.event.delta, 'Hello there')
  hub.stop()
})

test('running tool output is coalesced per call, deduplicated, and ordered before transitions', async () => {
  const { hub, source } = createHub()
  const { pushes, subscription } = collect(hub, ['t1'])
  await subscribe(subscription)

  source.emit(toolUpdate('tool-1', 'running', 'line 1'))
  source.emit(delta('m1', 'Running'))
  source.emit(toolUpdate('tool-1', 'running', 'line 2'))
  source.emit(toolUpdate('tool-1', 'running', 'line 3'))
  assert.equal(pushes.length, 0, 'preliminary output waits for the window')
  hub.flush()
  assert.deepEqual(flat(pushes), [
    [1, 'tool.updated'],
    [2, 'message.delta']
  ])
  assert.equal(
    (events(pushes)[0]!.toolCall as { outputPreview?: string }).outputPreview,
    'line 3',
    'the latest projection wins'
  )

  // Identical to what was last sent: nothing new goes out.
  source.emit(toolUpdate('tool-1', 'running', 'line 3'))
  hub.flush()
  assert.equal(flat(pushes).length, 2)

  // A transition flushes pending deltas first, then goes out immediately.
  source.emit(delta('m1', ' tests'))
  source.emit(toolUpdate('tool-1', 'running', 'line 4'))
  source.emit(toolUpdate('tool-1', 'completed', 'done'))
  assert.deepEqual(flat(pushes).slice(2), [
    [3, 'message.delta'],
    [4, 'tool.updated']
  ])
  assert.equal(
    (events(pushes)[3]!.toolCall as { status: string }).status,
    'completed',
    'the superseded running update is not sent'
  )
  source.emit(toolUpdate('tool-1', 'completed', 'done'))
  assert.equal(flat(pushes).length, 4, 'an identical terminal update is dropped')
  hub.stop()
})

test('subagent and background task activity is not forwarded', async () => {
  const { hub, source } = createHub()
  const { pushes, subscription } = collect(hub, ['t1'])
  await subscribe(subscription)
  source.emit({ type: 'subagent.progress', threadId: 't1' })
  source.emit({ type: 'background-task.started', threadId: 't1' })
  hub.flush()
  assert.deepEqual(pushes, [])
  hub.stop()
})

test('active snapshots accumulate raw text and reasoning before delta coalescing', () => {
  const { hub, source } = createHub()
  source.emit({
    type: 'message.started',
    threadId: 't1',
    runId: 'r1',
    messageId: 'm1',
    parentMessageId: 'user-1'
  })
  source.emit(delta('m1', 'Hel'))
  source.emit(delta('m1', 'lo'))
  source.emit({
    type: 'message.reasoning.delta',
    threadId: 't1',
    runId: 'r1',
    messageId: 'm1',
    delta: 'thinking'
  })
  assert.deepEqual(hub.snapshotMessages('t1', 'r1'), [
    {
      id: 'm1',
      parentMessageId: 'user-1',
      role: 'assistant',
      content: 'Hello',
      reasoning: 'thinking',
      images: [],
      attachments: [],
      status: 'streaming',
      createdAt: '2026-09-22T00:00:00.000Z',
      isPlanDocument: false
    }
  ])
  assert.deepEqual(hub.snapshotMessages('t1', 'other-run'), [])
  hub.stop()
})

test('completed messages and terminal runs leave no stale snapshot', () => {
  const { hub, source } = createHub()
  source.emit(delta('m1', 'first')) // A missing start still captures live content.
  source.emit(delta('m2', 'second'))
  source.emit({
    type: 'message.completed',
    threadId: 't1',
    runId: 'r1',
    message: {
      id: 'm1',
      role: 'assistant',
      content: 'first',
      status: 'completed',
      createdAt: '2026-09-22T00:00:00.000Z'
    }
  })
  assert.deepEqual(
    hub.snapshotMessages('t1', 'r1').map((message) => message.id),
    ['m2']
  )
  source.emit({ type: 'run.failed', threadId: 't1', runId: 'r1', error: 'error' })
  assert.deepEqual(hub.snapshotMessages('t1', 'r1'), [])
  hub.stop()
})

test('a flushed snapshot watermark excludes earlier deltas and remains unchanged after completion', async () => {
  const { hub, source } = createHub()
  source.emit(delta('m1', 'before'))
  hub.flush()
  const watermark = hub.headSeq
  const snapshot = hub.snapshotMessages('t1', 'r1')
  source.emit(delta('m1', ' after'))
  source.emit({ type: 'run.completed', threadId: 't1', runId: 'r1' })

  assert.equal(watermark, 1)
  assert.equal(snapshot[0]?.content, 'before')
  assert.equal(hub.snapshotMessages('t1', 'r1').length, 0)
  const { pushes, subscription } = collect(hub, ['t1'])
  assert.equal((await subscribe(subscription, { epoch: hub.epoch, seq: watermark })).resumed, true)
  assert.deepEqual(
    flat(pushes).map(([, type]) => type),
    ['message.delta', 'thread.summary', 'run.status'],
    'the summary changed while no phone was attached is fetched for the replay'
  )
  hub.stop()
})

test('thread-scope events reach only subscribed connections; inbox events reach all', async () => {
  const { hub, source } = createHub()
  const watching = collect(hub, ['t1'])
  const inboxOnly = collect(hub)
  await subscribe(watching.subscription)
  await subscribe(inboxOnly.subscription)

  source.emit({ type: 'message.started', threadId: 't1', runId: 'r1', messageId: 'm1' })
  source.emit({ type: 'run.completed', threadId: 't1', runId: 'r1' })

  assert.deepEqual(
    flat(watching.pushes).map(([, type]) => type),
    ['message.started', 'run.status']
  )
  assert.deepEqual(
    flat(inboxOnly.pushes).map(([, type]) => type),
    ['run.status']
  )
  hub.stop()
})

test('resume replays buffered events after the given seq', async () => {
  const { hub, source } = createQuietHub()
  for (let index = 0; index < 5; index += 1) {
    source.emit({ type: 'run.created', threadId: 't1', runId: `r${index}` })
  }

  const { pushes, subscription } = collect(hub)
  const result = await subscribe(subscription, { epoch: 'epoch-1', seq: 2 })

  assert.deepEqual(result, { epoch: 'epoch-1', headSeq: 5, resumed: true })
  assert.deepEqual(
    flat(pushes).map(([seq]) => seq),
    [3, 4, 5]
  )

  source.emit({ type: 'run.created', threadId: 't1', runId: 'live' })
  const live = pushes.at(-1)
  assert.equal(live?.type === 'event' ? live.seq : undefined, 6)
  hub.stop()
})

test('the subscribe response precedes the replay, and live events wait behind it in seq order', async () => {
  const { hub, source } = createQuietHub()
  source.emit({ type: 'run.created', threadId: 't1', runId: 'r1' })
  source.emit({ type: 'run.created', threadId: 't1', runId: 'r2' })
  const { pushes, subscription } = collect(hub)

  const result = await subscription.resume({ epoch: 'epoch-1', seq: 0 })
  assert.equal(result.resumed, true)
  assert.deepEqual(pushes, [], 'nothing is pushed before the response goes out')
  source.emit({ type: 'run.created', threadId: 't1', runId: 'r3' })
  assert.deepEqual(pushes, [], 'live events wait behind the replay')

  subscription.startDelivery()
  assert.deepEqual(
    flat(pushes).map(([seq]) => seq),
    [1, 2, 3]
  )
  source.emit({ type: 'run.created', threadId: 't1', runId: 'r4' })
  assert.deepEqual(
    flat(pushes).map(([seq]) => seq),
    [1, 2, 3, 4]
  )
  hub.stop()
})

test('a fresh subscribe also answers before any live event is delivered', async () => {
  const { hub, source } = createHub()
  const { pushes, subscription } = collect(hub)
  const result = await subscription.resume()
  assert.deepEqual(result, { epoch: 'epoch-1', headSeq: 0, resumed: false })
  source.emit({ type: 'run.created', threadId: 't1', runId: 'r1' })
  assert.deepEqual(pushes, [])
  subscription.startDelivery()
  assert.deepEqual(flat(pushes), [[1, 'run.status']])
  hub.stop()
})

test('resume asks for a resync when the epoch changed, the seq is ahead, or the journal lost it', async () => {
  const { hub, source } = createQuietHub({ bufferLimit: 2, journalLimit: 1 })
  source.emit({ type: 'run.created', threadId: 't1', runId: 'r0' })
  source.emit({ type: 'run.created', threadId: 't2', runId: 'r1' })
  source.emit({ type: 'run.created', threadId: 't3', runId: 'r2' })
  source.emit({ type: 'run.created', threadId: 't3', runId: 'r3' })

  // t1 and t2 were evicted from the one-thread journal, so seq 1 is no longer answerable.
  const lost = collect(hub)
  assert.deepEqual(await subscribe(lost.subscription, { epoch: 'epoch-1', seq: 1 }), {
    epoch: 'epoch-1',
    headSeq: 4,
    resumed: false
  })
  assert.equal(lost.pushes.length, 0)

  const edge = collect(hub)
  assert.equal((await subscribe(edge.subscription, { epoch: 'epoch-1', seq: 2 })).resumed, true)
  assert.deepEqual(
    flat(edge.pushes).map(([seq]) => seq),
    [3, 4]
  )

  assert.equal(
    (await subscribe(collect(hub).subscription, { epoch: 'epoch-0', seq: 3 })).resumed,
    false
  )
  assert.equal(
    (await subscribe(collect(hub).subscription, { epoch: 'epoch-1', seq: 5 })).resumed,
    false
  )
  hub.stop()
})

test('an inbox resume older than the ring replays the journal and invalidates open threads', async () => {
  let now = 0
  const fetched: string[] = []
  const { hub, source } = createHub({
    now: () => now,
    getThreadSummary: async (threadId) => {
      fetched.push(threadId)
      return { ...summary(threadId), title: `${threadId} now` }
    }
  })
  const phone = collect(hub, ['t1'])
  await subscribe(phone.subscription)
  source.emit({ type: 'thread.updated', threadId: 't2' })
  hub.flush()
  await tick()
  source.emit({ type: 'run.created', threadId: 't2', runId: 'r1' })
  source.emit({ type: 'run.completed', threadId: 't2', runId: 'r1' })
  source.emit({ type: 'message.started', threadId: 't1', runId: 'r9', messageId: 'm1' })
  source.emit({ type: 'thread.archived', threadId: 't3' })
  phone.subscription.close()
  hub.flush()
  // Everything above ages out of the ring.
  now = 6 * 60 * 1000
  source.emit({ type: 'run.created', threadId: 't4', runId: 'r2' })
  fetched.length = 0

  const resumed = collect(hub, ['t1'])
  const result = await subscribe(resumed.subscription, { epoch: 'epoch-1', seq: 0 })
  assert.equal(result.resumed, true)
  const replay = events(resumed.pushes)
  assert.deepEqual(
    replay.map((event) => [event.type, event.threadId]),
    [
      ['thread.summary', 't2'],
      ['run.status', 't2'],
      ['thread.removed', 't3'],
      ['thread.summary', 't4'],
      ['run.status', 't4'],
      ['thread.invalidated', 't1']
    ]
  )
  assert.equal(replay[1]!.status, 'completed', 'only the latest run status survives')
  assert.equal((replay[0]!.summary as RemoteThreadSummary).title, 't2 now', 'fetched at replay')
  assert.deepEqual(fetched.sort(), ['t2', 't4'])
  const seqs = flat(resumed.pushes).map(([seq]) => seq)
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    'replayed seqs ascend'
  )
  assert.ok(seqs.at(-1)! > result.headSeq - 1 && seqs.at(-1) === result.headSeq)
  hub.stop()
})

test('summaries are fetched only while a phone is attached and never repeated unchanged', async () => {
  let calls = 0
  let title = 'first'
  const { hub, source } = createHub({
    getThreadSummary: async (threadId) => {
      calls += 1
      return { ...summary(threadId), title }
    }
  })
  source.emit({ type: 'thread.updated', threadId: 't9' })
  hub.flush()
  await tick()
  assert.equal(calls, 0, 'no summary RPC without a phone')
  const deferredSeq = hub.headSeq
  assert.equal(deferredSeq, 1, 'the change is still numbered for a later resume')

  const phone = collect(hub)
  const result = await subscribe(phone.subscription, { epoch: 'epoch-1', seq: 0 })
  assert.equal(result.resumed, true)
  assert.deepEqual(flat(phone.pushes), [[1, 'thread.summary']])
  assert.equal(calls, 1)

  source.emit({ type: 'thread.updated', threadId: 't9' })
  hub.flush()
  await tick()
  source.emit({ type: 'thread.updated', threadId: 't9' })
  hub.flush()
  await tick()
  assert.equal(flat(phone.pushes).length, 2, 'the same summary is pushed once')
  title = 'second'
  source.emit({ type: 'thread.updated', threadId: 't9' })
  hub.flush()
  await tick()
  assert.equal(flat(phone.pushes).length, 3)
  hub.stop()
})

test('replays are compacted: merged deltas, completed messages, latest summary and tool state', () => {
  const at = (seq: number, event: Record<string, unknown>): { seq: number; event: never } => ({
    seq,
    event: { threadId: 't1', runId: 'r1', ...event } as never
  })
  const compacted = compactReplay([
    at(1, { type: 'message.started', messageId: 'm1' }),
    at(2, { type: 'message.delta', messageId: 'm1', delta: 'Hel' }),
    at(3, { type: 'tool.updated', toolCall: { id: 'tool', status: 'running' } }),
    at(4, { type: 'message.delta', messageId: 'm1', delta: 'lo' }),
    at(5, { type: 'message.reasoning.delta', messageId: 'm1', delta: 'hm' }),
    at(6, { type: 'thread.summary', summary: { title: 'old' } }),
    at(7, { type: 'message.delta', messageId: 'm2', delta: 'gone' }),
    at(8, { type: 'tool.updated', toolCall: { id: 'tool', status: 'completed' } }),
    at(9, { type: 'message.completed', message: { id: 'm2' } }),
    at(10, { type: 'thread.summary', summary: { title: 'new' } }),
    at(11, { type: 'message.delta', messageId: 'm1', delta: '!' }),
    at(12, { type: 'message.started', messageId: 'm1' }),
    at(13, { type: 'message.delta', messageId: 'm1', delta: 'again' })
  ])
  assert.deepEqual(
    compacted.map((item) => [
      item.seq,
      (item.event as { type: string }).type,
      (item.event as { delta?: string }).delta
    ]),
    [
      [1, 'message.started', undefined],
      [5, 'message.reasoning.delta', 'hm'],
      [8, 'tool.updated', undefined],
      [9, 'message.completed', undefined],
      [10, 'thread.summary', undefined],
      [11, 'message.delta', 'Hello!'],
      [12, 'message.started', undefined],
      [13, 'message.delta', 'again']
    ]
  )
})

test('an oversized thread replay becomes one invalidation; inbox events stay', async () => {
  const { hub, source } = createQuietHub({ bufferLimit: 10_000 })
  for (let index = 0; index < 300; index += 1) {
    source.emit(toolUpdate(`tool-${index}`, 'completed'))
  }
  source.emit({ type: 'run.completed', threadId: 't1', runId: 'r1' })
  const { pushes, subscription } = collect(hub, ['t1'])
  assert.equal((await subscribe(subscription, { epoch: 'epoch-1', seq: 0 })).resumed, true)
  assert.deepEqual(flat(pushes), [
    [300, 'thread.invalidated'],
    [301, 'run.status']
  ])
  hub.stop()
})

test('event-batch subscribers get one batch per flush and bounded replay batches', async () => {
  const { hub, source } = createQuietHub({ bufferLimit: 10_000 })
  for (let index = 0; index < 600; index += 1) {
    source.emit({ type: 'run.created', threadId: `t${index}`, runId: `r${index}` })
  }
  const batched = collect(hub, ['t1'], { batch: true })
  const legacy = collect(hub, ['t1'])
  await subscribe(batched.subscription, { epoch: 'epoch-1', seq: 0 })
  await subscribe(legacy.subscription, { epoch: 'epoch-1', seq: 600 })
  assert.ok(batched.pushes.every((push) => push.type === 'batch'))
  assert.deepEqual(
    batched.pushes.map((push) => (push.type === 'batch' ? push.items.length : 0)),
    [256, 256, 88]
  )

  batched.pushes.length = 0
  source.emit(delta('m1', 'a'))
  source.emit({
    type: 'message.reasoning.delta',
    threadId: 't1',
    runId: 'r1',
    messageId: 'm1',
    delta: 'b'
  })
  source.emit({ type: 'run.completed', threadId: 't1', runId: 'r1' })
  assert.equal(batched.pushes.length, 1)
  const batch = batched.pushes[0]
  assert.ok(batch?.type === 'batch')
  assert.equal(batch.epoch, 'epoch-1')
  assert.deepEqual(
    batch.items.map((item) => [item.seq, item.event.type]),
    [
      [601, 'message.delta'],
      [602, 'message.reasoning.delta'],
      [603, 'run.status']
    ]
  )
  assert.deepEqual(
    legacy.pushes.map((push) => push.type),
    ['event', 'event', 'event'],
    'phones without event-batch keep single pushes'
  )
  hub.stop()
})

test('epoch, seq and journal survive a clean restart; an unclean one starts a new epoch', async () => {
  const persistence = memoryPersistence()
  let epochs = 0
  const make = (): { hub: RemoteEventHub; source: ReturnType<typeof createSource> } =>
    createHub({ persistence, createEpoch: () => `epoch-${++epochs}` })

  const first = make()
  first.source.emit({ type: 'run.created', threadId: 't1', runId: 'r1' })
  first.source.emit({ type: 'thread.updated', threadId: 't2' })
  first.hub.stop()

  const second = make()
  assert.equal(second.hub.epoch, 'epoch-1')
  // t1's summary deferred (seq 1), its run status (2), t2's summary still waiting at stop (3).
  assert.equal(second.hub.headSeq, 3)
  const phone = collect(second.hub, ['t1'])
  assert.equal((await subscribe(phone.subscription, { epoch: 'epoch-1', seq: 1 })).resumed, true)
  assert.deepEqual(
    events(phone.pushes).map((event) => [event.type, event.threadId]),
    [
      ['run.status', 't1'],
      ['thread.summary', 't2'],
      ['thread.invalidated', 't1']
    ]
  )
  assert.deepEqual(
    flat(phone.pushes).map(([seq]) => seq),
    [2, 3, 4]
  )
  // No stop(): the process "crashed".

  const third = make()
  assert.equal(third.hub.epoch, 'epoch-2')
  assert.equal(third.hub.headSeq, 0)
  third.hub.stop()
})

test('run status of threads the phone may not see never leaves the hub', async () => {
  const lookups: string[] = []
  const { hub, source } = createHub({
    getThreadSummary: async () => null,
    getThreadVisibility: async (threadId) => {
      lookups.push(threadId)
      return threadId !== 'guest'
    }
  })
  const { pushes, subscription } = collect(hub, ['guest'])
  await subscribe(subscription)

  source.emit({ type: 'run.created', threadId: 'guest', runId: 'g1' })
  source.emit({ type: 'run.completed', threadId: 'guest', runId: 'g1' })
  source.emit({ type: 'run.created', threadId: 'local', runId: 'l1' })
  await tick()
  source.emit({ type: 'run.created', threadId: 'guest', runId: 'g2' })
  source.emit({ type: 'run.completed', threadId: 'local', runId: 'l1' })

  assert.deepEqual(
    events(pushes).map((event) => [event.threadId, event.status]),
    [
      ['local', 'running'],
      ['local', 'completed']
    ]
  )
  assert.deepEqual(lookups.sort(), ['guest', 'local'], 'visibility is looked up once per thread')
  hub.stop()
})

test('settings events only surface the appearance, never provider settings', async () => {
  const { hub, source } = createHub()
  const { pushes, subscription } = collect(hub)
  await subscribe(subscription)

  const settingsEvent = {
    type: 'settings.updated',
    config: {
      providers: [{ name: 'p', apiKey: 'sk-hub-canary', baseUrl: 'https://x', modelList: {} }],
      general: { themeId: 'aoba', themeAppearance: 'dark' }
    },
    settings: { apiKey: 'sk-hub-canary' }
  } as unknown as YachiyoServerEvent
  const version = hub.settingsVersion
  source.emit(settingsEvent as unknown as LooseEvent)
  source.emit(settingsEvent as unknown as LooseEvent)

  assert.equal(hub.settingsVersion, version + 2)
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
  await subscribe(subscription)

  source.emit({ type: 'thread.updated', threadId: 't9' })
  source.emit({ type: 'thread.updated', threadId: 't9' })
  hub.flush()
  await tick()

  assert.deepEqual(
    pushes.map((push) => push.type === 'event' && push.event),
    [{ type: 'thread.summary', threadId: 't9', summary: summary('t9') }]
  )
  hub.stop()
})

test('a read-only mirror with no remote summary does not emit an inbox event', async () => {
  const source = createSource()
  const hub = new RemoteEventHub({
    subscribe: source.subscribe,
    getThreadSummary: async () => null,
    coalesceMs: 60_000
  })
  hub.start()
  const { pushes, subscription } = collect(hub)
  await subscribe(subscription)

  source.emit({ type: 'thread.updated', threadId: 'mirror' })
  hub.flush()
  await tick()

  assert.deepEqual(pushes, [])
  hub.stop()
})

test('stopping the hub releases the server subscription', () => {
  const { hub, source } = createHub()
  assert.equal(source.listenerCount(), 1)
  hub.stop()
  assert.equal(source.listenerCount(), 0)
})
