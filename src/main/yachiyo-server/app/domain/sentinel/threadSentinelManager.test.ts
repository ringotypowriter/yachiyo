import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createThreadSentinelManager } from './threadSentinelManager.ts'

function createManualClock(startMs = Date.parse('2026-05-23T08:00:00.000Z')): {
  now: () => number
  advance: (ms: number) => void
  fire: () => Promise<void>
  scheduledDelay: () => number | undefined
} {
  let current = startMs
  let callback: (() => void) | undefined
  let delay: number | undefined

  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
    fire: async () => {
      callback?.()
      await Promise.resolve()
    },
    scheduledDelay: () => delay,
    set callback(value: (() => void) | undefined) {
      callback = value
    },
    set delay(value: number | undefined) {
      delay = value
    }
  } as ReturnType<typeof createManualClock> & {
    callback?: () => void
    delay?: number
  }
}

describe('thread sentinel manager', () => {
  it('sets sentinel state without scheduling until the run reaches a terminal state', () => {
    const clock = createManualClock()
    const events: unknown[] = []
    const manager = createThreadSentinelManager({
      now: clock.now,
      setTimer: (callback, delayMs) => {
        ;(clock as typeof clock & { callback?: () => void; delay?: number }).callback = callback
        ;(clock as typeof clock & { callback?: () => void; delay?: number }).delay = delayMs
        return Symbol('timer')
      },
      clearTimer: () => {},
      emit: (event) => events.push(event),
      wakeThread: async () => {}
    })

    const state = manager.set({
      threadId: 'thread-1',
      goal: 'Watch the build',
      stopCondition: 'The build has finished',
      intervalMinutes: 3
    })

    assert.equal(state.nextRunAt, undefined)
    assert.equal(clock.scheduledDelay(), undefined)
    assert.equal(events.length, 1)

    manager.onRunTerminal('thread-1')

    assert.equal(clock.scheduledDelay(), 180_000)
    assert.equal(manager.get('thread-1')?.nextRunAt, '2026-05-23T08:03:00.000Z')
  })

  it('rejects sentinel intervals below one minute', () => {
    const manager = createThreadSentinelManager({
      now: () => Date.now(),
      setTimer: () => Symbol('timer'),
      clearTimer: () => {},
      emit: () => {},
      wakeThread: async () => {}
    })

    assert.throws(
      () =>
        manager.set({
          threadId: 'thread-1',
          goal: 'Watch the build',
          stopCondition: 'The build has finished',
          intervalMinutes: 0
        }),
      /at least 1 minute/
    )
  })

  it('clears sentinel state and cancels the timer', () => {
    let cleared = 0
    const manager = createThreadSentinelManager({
      now: () => Date.parse('2026-05-23T08:00:00.000Z'),
      setTimer: () => Symbol('timer'),
      clearTimer: () => {
        cleared += 1
      },
      emit: () => {},
      wakeThread: async () => {}
    })

    manager.set({
      threadId: 'thread-1',
      goal: 'Watch the build',
      stopCondition: 'The build has finished',
      intervalMinutes: 1
    })
    manager.onRunTerminal('thread-1')

    assert.equal(manager.clear('thread-1'), true)
    assert.equal(manager.get('thread-1'), undefined)
    assert.equal(cleared, 1)
  })

  it('wakes the same thread with the saved goal and stop condition when the timer fires', async () => {
    const clock = createManualClock()
    const prompts: Array<{ threadId: string; content: string }> = []
    const manager = createThreadSentinelManager({
      now: clock.now,
      setTimer: (callback, delayMs) => {
        ;(clock as typeof clock & { callback?: () => void; delay?: number }).callback = callback
        ;(clock as typeof clock & { callback?: () => void; delay?: number }).delay = delayMs
        return Symbol('timer')
      },
      clearTimer: () => {},
      emit: () => {},
      wakeThread: async (input) => {
        prompts.push(input)
      }
    })

    manager.set({
      threadId: 'thread-1',
      goal: 'Watch the build',
      stopCondition: 'The build has finished',
      intervalMinutes: 1
    })
    manager.onRunTerminal('thread-1')
    await clock.fire()

    assert.equal(prompts.length, 1)
    assert.equal(prompts[0]?.threadId, 'thread-1')
    assert.match(prompts[0]?.content ?? '', /Watch the build/)
    assert.match(prompts[0]?.content ?? '', /The build has finished/)
    assert.match(prompts[0]?.content ?? '', /useSentinel/)
    assert.equal(manager.get('thread-1')?.nextRunAt, undefined)
  })

  it('handles wake failures from the timer callback', async () => {
    const clock = createManualClock()
    const manager = createThreadSentinelManager({
      now: clock.now,
      setTimer: (callback, delayMs) => {
        ;(clock as typeof clock & { callback?: () => void; delay?: number }).callback = callback
        ;(clock as typeof clock & { callback?: () => void; delay?: number }).delay = delayMs
        return Symbol('timer')
      },
      clearTimer: () => {},
      emit: () => {},
      wakeThread: async () => {
        throw new Error('Thread no longer exists')
      }
    })

    manager.set({
      threadId: 'thread-1',
      goal: 'Watch the build',
      stopCondition: 'The build has finished',
      intervalMinutes: 1
    })
    manager.onRunTerminal('thread-1')

    await assert.doesNotReject(clock.fire())
  })
})
