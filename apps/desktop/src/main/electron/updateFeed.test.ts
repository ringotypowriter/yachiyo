import assert from 'node:assert/strict'
import test from 'node:test'

import { mirrorFeedUrl, resolveUpdateFeed } from './updateFeed.ts'

function okFetch(
  calls: string[]
): (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }> {
  return async (url) => {
    calls.push(url)
    return { ok: true }
  }
}

test('mirrorFeedUrl maps stable channel to /stable', () => {
  assert.equal(mirrorFeedUrl('https://dl.example.com', 'stable'), 'https://dl.example.com/stable')
})

test('mirrorFeedUrl maps beta channel to /nightly', () => {
  assert.equal(mirrorFeedUrl('https://dl.example.com', 'beta'), 'https://dl.example.com/nightly')
})

test('mirrorFeedUrl trims trailing slash from base', () => {
  assert.equal(mirrorFeedUrl('https://dl.example.com/', 'stable'), 'https://dl.example.com/stable')
})

test('resolveUpdateFeed returns mirror feed when probe succeeds', async () => {
  const calls: string[] = []
  const feed = await resolveUpdateFeed({
    mirrorBase: 'https://dl.example.com',
    channel: 'stable',
    fetchFn: okFetch(calls)
  })
  assert.deepEqual(feed, { source: 'mirror', url: 'https://dl.example.com/stable' })
  assert.deepEqual(calls, ['https://dl.example.com/stable/latest-mac.yml'])
})

test('resolveUpdateFeed probes the nightly dir for the beta channel', async () => {
  const calls: string[] = []
  const feed = await resolveUpdateFeed({
    mirrorBase: 'https://dl.example.com',
    channel: 'beta',
    fetchFn: okFetch(calls)
  })
  assert.deepEqual(feed, { source: 'mirror', url: 'https://dl.example.com/nightly' })
  assert.deepEqual(calls, ['https://dl.example.com/nightly/latest-mac.yml'])
})

test('resolveUpdateFeed falls back to github on non-ok response', async () => {
  const feed = await resolveUpdateFeed({
    mirrorBase: 'https://dl.example.com',
    channel: 'stable',
    fetchFn: async () => ({ ok: false })
  })
  assert.deepEqual(feed, { source: 'github' })
})

test('resolveUpdateFeed falls back to github when the probe throws', async () => {
  const feed = await resolveUpdateFeed({
    mirrorBase: 'https://dl.example.com',
    channel: 'stable',
    fetchFn: async () => {
      throw new Error('network down')
    }
  })
  assert.deepEqual(feed, { source: 'github' })
})

test('resolveUpdateFeed falls back to github when the probe times out', async () => {
  const feed = await resolveUpdateFeed({
    mirrorBase: 'https://dl.example.com',
    channel: 'stable',
    timeoutMs: 20,
    fetchFn: (_url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
        // AbortSignal.timeout timers do not keep the event loop alive; a real
        // timer stands in for the socket work a live fetch would have pending.
        setTimeout(() => resolve({ ok: true }), 200)
      })
  })
  assert.deepEqual(feed, { source: 'github' })
})

test('resolveUpdateFeed skips probing when no mirror is configured', async () => {
  const calls: string[] = []
  const feed = await resolveUpdateFeed({
    mirrorBase: '',
    channel: 'stable',
    fetchFn: okFetch(calls)
  })
  assert.deepEqual(feed, { source: 'github' })
  assert.deepEqual(calls, [])
})
