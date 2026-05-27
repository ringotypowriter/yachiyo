import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { hasInternetConnection } from './scheduleService.ts'

describe('hasInternetConnection', () => {
  it('returns true when fetch succeeds with ok response', async () => {
    const restore = mock.method(globalThis, 'fetch', async () => ({
      ok: true
    }))

    const result = await hasInternetConnection()
    assert.equal(result, true)
    assert.equal(restore.mock.calls.length, 1)

    const call = restore.mock.calls[0]
    assert.equal(call.arguments[0], 'https://example.com')
    assert.equal(call.arguments[1]?.method, 'HEAD')

    restore.mock.restore()
  })

  it('returns true on a later retry after initial failure', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    let calls = 0
    const restore = mock.method(globalThis, 'fetch', async () => {
      calls += 1
      return { ok: calls >= 2 }
    })

    const resultPromise = hasInternetConnection()
    await Promise.resolve()
    mock.timers.runAll()
    await Promise.resolve()
    mock.timers.runAll()
    const result = await resultPromise
    assert.equal(result, true)
    assert.equal(restore.mock.calls.length, 2)

    restore.mock.restore()
    mock.timers.reset()
  })

  it('returns false when fetch always returns non-ok', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const restore = mock.method(globalThis, 'fetch', async () => ({
      ok: false
    }))

    const resultPromise = hasInternetConnection()
    await Promise.resolve()
    mock.timers.runAll()
    await Promise.resolve()
    mock.timers.runAll()
    await Promise.resolve()
    mock.timers.runAll()
    const result = await resultPromise
    assert.equal(result, false)
    assert.equal(restore.mock.calls.length, 3)

    restore.mock.restore()
    mock.timers.reset()
  })

  it('returns false when fetch always throws (network error)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const restore = mock.method(globalThis, 'fetch', async () => {
      throw new Error('Network unreachable')
    })

    const resultPromise = hasInternetConnection()
    await Promise.resolve()
    mock.timers.runAll()
    await Promise.resolve()
    mock.timers.runAll()
    await Promise.resolve()
    mock.timers.runAll()
    const result = await resultPromise
    assert.equal(result, false)
    assert.equal(restore.mock.calls.length, 3)

    restore.mock.restore()
    mock.timers.reset()
  })

  it('returns false when fetch is aborted (timeout)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const restore = mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      // Simulate a slow request that gets aborted
      if (init?.signal) {
        init.signal.throwIfAborted()
      }
      throw new DOMException('The operation was aborted.', 'AbortError')
    })

    const resultPromise = hasInternetConnection()
    await Promise.resolve()
    mock.timers.runAll()
    await Promise.resolve()
    mock.timers.runAll()
    await Promise.resolve()
    mock.timers.runAll()
    const result = await resultPromise
    assert.equal(result, false)
    assert.equal(restore.mock.calls.length, 3)

    restore.mock.restore()
    mock.timers.reset()
  })
})
