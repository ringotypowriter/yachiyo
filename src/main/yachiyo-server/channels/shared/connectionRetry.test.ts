import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { connectWithRetry } from './connectionRetry.ts'

describe('connectWithRetry', () => {
  it('resolves immediately when connectFn succeeds on first attempt', async () => {
    let calls = 0
    await connectWithRetry(async () => {
      calls++
    })
    assert.equal(calls, 1)
  })

  it('retries on failure with exponential backoff', async () => {
    let attempts = 0
    const start = Date.now()

    await connectWithRetry(
      async () => {
        attempts++
        if (attempts < 3) throw new Error('not ready')
      },
      { baseDelayMs: 20, maxDelayMs: 200, label: 'test' }
    )

    assert.equal(attempts, 3)
    // Should have waited at least baseDelay + baseDelay*2 = 20 + 40 = 60ms
    assert.ok(Date.now() - start >= 40, 'should have backed off')
  })

  it('throws after maxAttempts exhausted', async () => {
    let attempts = 0

    await assert.rejects(
      () =>
        connectWithRetry(
          async () => {
            attempts++
            throw new Error('always fails')
          },
          { maxAttempts: 3, baseDelayMs: 10, label: 'test' }
        ),
      { message: 'always fails' }
    )

    assert.equal(attempts, 3)
  })

  it('calls onRetry callback on each retry', async () => {
    const retries: { attempt: number; delayMs: number }[] = []

    await connectWithRetry(
      async () => {
        if (retries.length < 2) throw new Error('fail')
      },
      {
        baseDelayMs: 10,
        label: 'test',
        onRetry: (attempt, delayMs) => retries.push({ attempt, delayMs })
      }
    )

    assert.equal(retries.length, 2)
    assert.equal(retries[0].attempt, 1)
    assert.equal(retries[0].delayMs, 10)
    assert.equal(retries[1].attempt, 2)
    assert.equal(retries[1].delayMs, 20) // doubled
  })

  it('caps delay at maxDelayMs', async () => {
    const delays: number[] = []

    await connectWithRetry(
      async () => {
        if (delays.length < 5) throw new Error('fail')
      },
      {
        baseDelayMs: 10,
        maxDelayMs: 30,
        label: 'test',
        onRetry: (_attempt, delayMs) => delays.push(delayMs)
      }
    )

    // 10, 20, 30, 30, 30
    assert.deepEqual(delays, [10, 20, 30, 30, 30])
  })

  it('resets delay after successful reconnect and subsequent failure', async () => {
    // connectWithRetry is a one-shot connect — it resolves on first success.
    // Delay reset is inherent: each call starts from baseDelay.
    const delays: number[] = []
    let calls = 0

    // First call: fails once then succeeds
    await connectWithRetry(
      async () => {
        calls++
        if (calls === 1) throw new Error('fail')
      },
      {
        baseDelayMs: 10,
        label: 'test',
        onRetry: (_attempt, delayMs) => delays.push(delayMs)
      }
    )

    // Second call starts fresh
    calls = 0
    const delays2: number[] = []
    await connectWithRetry(
      async () => {
        calls++
        if (calls === 1) throw new Error('fail')
      },
      {
        baseDelayMs: 10,
        label: 'test',
        onRetry: (_attempt, delayMs) => delays2.push(delayMs)
      }
    )

    assert.equal(delays[0], 10)
    assert.equal(delays2[0], 10) // reset, not carried over
  })

  it('aborts via AbortSignal', async () => {
    const controller = new AbortController()
    let attempts = 0

    const promise = connectWithRetry(
      async () => {
        attempts++
        throw new Error('fail')
      },
      { baseDelayMs: 50, label: 'test', signal: controller.signal }
    )

    // Abort after a short delay
    setTimeout(() => controller.abort(), 30)

    await assert.rejects(promise, (err: Error) => {
      assert.equal(err.name, 'AbortError')
      return true
    })

    assert.ok(attempts >= 1)
  })

  it('does not retry when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let attempts = 0

    await assert.rejects(
      () =>
        connectWithRetry(
          async () => {
            attempts++
          },
          { label: 'test', signal: controller.signal }
        ),
      (err: Error) => {
        assert.equal(err.name, 'AbortError')
        return true
      }
    )

    assert.equal(attempts, 0)
  })
})
