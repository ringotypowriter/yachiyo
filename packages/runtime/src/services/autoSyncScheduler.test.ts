import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createAutoSyncScheduler, type AutoSyncClock } from './autoSyncScheduler.ts'

/** Let pending microtasks (the single-flight drain loop) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

interface FakeClock extends AutoSyncClock {
  advance(ms: number): void
}

function createFakeClock(): FakeClock {
  let nowMs = 0
  let seq = 0
  const timeouts = new Map<number, { fireAt: number; fn: () => void }>()
  const intervals = new Map<number, { every: number; nextAt: number; fn: () => void }>()

  return {
    setTimeout(fn, ms) {
      const id = ++seq
      timeouts.set(id, { fireAt: nowMs + ms, fn })
      return id
    },
    clearTimeout(handle) {
      timeouts.delete(handle as number)
    },
    setInterval(fn, ms) {
      const id = ++seq
      intervals.set(id, { every: ms, nextAt: nowMs + ms, fn })
      return id
    },
    clearInterval(handle) {
      intervals.delete(handle as number)
    },
    advance(ms) {
      const target = nowMs + ms
      for (;;) {
        let next: { at: number; run: () => void } | null = null
        for (const [id, t] of timeouts) {
          if (t.fireAt <= target && (!next || t.fireAt < next.at)) {
            next = { at: t.fireAt, run: () => (timeouts.delete(id), t.fn()) }
          }
        }
        for (const [, iv] of intervals) {
          if (iv.nextAt <= target && (!next || iv.nextAt < next.at)) {
            next = {
              at: iv.nextAt,
              run: () => {
                iv.nextAt += iv.every
                iv.fn()
              }
            }
          }
        }
        if (!next) break
        nowMs = next.at
        next.run()
      }
      nowMs = target
    }
  }
}

/** A runSync stub whose resolution the test controls deferred-by-deferred. */
function createDeferredRunSync(): {
  runSync: () => Promise<unknown>
  callCount: () => number
  resolveNext: () => void
} {
  let calls = 0
  const resolvers: Array<() => void> = []
  return {
    runSync: () =>
      new Promise<void>((resolve) => {
        calls += 1
        resolvers.push(resolve)
      }),
    callCount: () => calls,
    resolveNext: () => {
      const next = resolvers.shift()
      if (next) next()
    }
  }
}

const HUGE = 1_000_000

describe('createAutoSyncScheduler', () => {
  it('coalesces a burst of local-change events into a single debounced sync', async () => {
    const clock = createFakeClock()
    let calls = 0
    let emit: (event: { type: string }) => void = () => {}
    const scheduler = createAutoSyncScheduler({
      runSync: async () => {
        calls += 1
      },
      subscribe: (listener) => {
        emit = listener
        return () => {}
      },
      pullIntervalMs: HUGE,
      startupDelayMs: HUGE,
      pushDebounceMs: 3000,
      clock
    })
    scheduler.start()

    emit({ type: 'settings.updated' })
    clock.advance(1000)
    emit({ type: 'thread.updated' })
    clock.advance(1000)
    emit({ type: 'run.completed' })
    // Debounce keeps resetting; nothing should have fired yet.
    clock.advance(2000)
    await flush()
    assert.equal(calls, 0)

    clock.advance(1000) // 3000ms since the last event -> debounce fires
    await flush()
    assert.equal(calls, 1)
  })

  it('ignores event types that are not sync triggers', async () => {
    const clock = createFakeClock()
    let calls = 0
    let emit: (event: { type: string }) => void = () => {}
    const scheduler = createAutoSyncScheduler({
      runSync: async () => {
        calls += 1
      },
      subscribe: (listener) => {
        emit = listener
        return () => {}
      },
      pullIntervalMs: HUGE,
      startupDelayMs: HUGE,
      pushDebounceMs: 3000,
      clock
    })
    scheduler.start()

    emit({ type: 'message.delta' })
    emit({ type: 'run.created' })
    clock.advance(5000)
    await flush()
    assert.equal(calls, 0)
  })

  it('runs a periodic pull sync on the interval', async () => {
    const clock = createFakeClock()
    let calls = 0
    const scheduler = createAutoSyncScheduler({
      runSync: async () => {
        calls += 1
      },
      subscribe: () => () => {},
      pullIntervalMs: 1000,
      startupDelayMs: HUGE,
      pushDebounceMs: HUGE,
      clock
    })
    scheduler.start()

    clock.advance(1000)
    await flush()
    clock.advance(1000)
    await flush()
    clock.advance(1000)
    await flush()
    assert.equal(calls, 3)
  })

  it('runs a catch-up sync after the startup delay', async () => {
    const clock = createFakeClock()
    let calls = 0
    const scheduler = createAutoSyncScheduler({
      runSync: async () => {
        calls += 1
      },
      subscribe: () => () => {},
      pullIntervalMs: HUGE,
      startupDelayMs: 5000,
      pushDebounceMs: HUGE,
      clock
    })
    scheduler.start()

    clock.advance(4999)
    await flush()
    assert.equal(calls, 0)
    clock.advance(1)
    await flush()
    assert.equal(calls, 1)
  })

  it('never overlaps syncs and collapses concurrent requests into one follow-up', async () => {
    const clock = createFakeClock()
    const deferred = createDeferredRunSync()
    const scheduler = createAutoSyncScheduler({
      runSync: deferred.runSync,
      subscribe: () => () => {},
      pullIntervalMs: HUGE,
      startupDelayMs: HUGE,
      pushDebounceMs: HUGE,
      clock
    })
    scheduler.start()

    scheduler.triggerNow() // starts sync #1 (in flight)
    await flush()
    assert.equal(deferred.callCount(), 1)

    scheduler.triggerNow() // queued while #1 runs
    scheduler.triggerNow() // collapses with the queued one
    await flush()
    assert.equal(deferred.callCount(), 1, 'no second sync starts while one is in flight')

    deferred.resolveNext() // #1 done -> exactly one follow-up runs
    await flush()
    assert.equal(deferred.callCount(), 2)

    deferred.resolveNext() // #2 done -> nothing pending
    await flush()
    assert.equal(deferred.callCount(), 2)
  })

  it('recovers from a failing sync and reports the error', async () => {
    const clock = createFakeClock()
    let calls = 0
    const errors: unknown[] = []
    const scheduler = createAutoSyncScheduler({
      runSync: async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
      },
      subscribe: () => () => {},
      onError: (error) => errors.push(error),
      pullIntervalMs: HUGE,
      startupDelayMs: HUGE,
      pushDebounceMs: HUGE,
      clock
    })
    scheduler.start()

    scheduler.triggerNow()
    await flush()
    assert.equal(calls, 1)
    assert.equal(errors.length, 1)

    // A failure must not strand the single-flight gate: the next request runs.
    scheduler.triggerNow()
    await flush()
    assert.equal(calls, 2)
  })

  it('stops timers and unsubscribes on stop', async () => {
    const clock = createFakeClock()
    let calls = 0
    let unsubscribed = false
    const scheduler = createAutoSyncScheduler({
      runSync: async () => {
        calls += 1
      },
      subscribe: () => () => {
        unsubscribed = true
      },
      pullIntervalMs: 1000,
      startupDelayMs: 1000,
      pushDebounceMs: 1000,
      clock
    })
    scheduler.start()
    scheduler.stop()

    assert.equal(unsubscribed, true)
    clock.advance(10000)
    await flush()
    assert.equal(calls, 0)
  })
})
