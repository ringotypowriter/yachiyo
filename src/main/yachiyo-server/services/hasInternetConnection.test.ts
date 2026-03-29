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

  it('returns false when fetch succeeds with non-ok response', async () => {
    const restore = mock.method(globalThis, 'fetch', async () => ({
      ok: false
    }))

    const result = await hasInternetConnection()
    assert.equal(result, false)

    restore.mock.restore()
  })

  it('returns false when fetch throws (network error)', async () => {
    const restore = mock.method(globalThis, 'fetch', async () => {
      throw new Error('Network unreachable')
    })

    const result = await hasInternetConnection()
    assert.equal(result, false)

    restore.mock.restore()
  })

  it('returns false when fetch is aborted (timeout)', async () => {
    const restore = mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      // Simulate a slow request that gets aborted
      if (init?.signal) {
        init.signal.throwIfAborted()
      }
      throw new DOMException('The operation was aborted.', 'AbortError')
    })

    const result = await hasInternetConnection()
    assert.equal(result, false)

    restore.mock.restore()
  })
})
