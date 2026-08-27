import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkUpdateFeeds,
  mirrorFeedUrl,
  resolveUpdateFeed,
  resolveUpdateFeeds
} from './updateFeed.ts'

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
    platform: 'darwin',
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
    platform: 'darwin',
    fetchFn: okFetch(calls)
  })
  assert.deepEqual(feed, { source: 'mirror', url: 'https://dl.example.com/nightly' })
  assert.deepEqual(calls, ['https://dl.example.com/nightly/latest-mac.yml'])
})

test('resolveUpdateFeeds lets beta users receive a newer stable release', async () => {
  const calls: string[] = []
  const feeds = await resolveUpdateFeeds({
    mirrorBase: 'https://dl.example.com',
    channel: 'beta',
    platform: 'darwin',
    fetchFn: okFetch(calls)
  })

  assert.deepEqual(feeds, [
    { source: 'mirror', url: 'https://dl.example.com/nightly' },
    { source: 'mirror', url: 'https://dl.example.com/stable' },
    { source: 'github' }
  ])
  assert.deepEqual(calls, [
    'https://dl.example.com/nightly/latest-mac.yml',
    'https://dl.example.com/stable/latest-mac.yml'
  ])
})

test('checkUpdateFeeds continues from an unchanged nightly to a newer stable build', async () => {
  const checked: string[] = []
  const result = await checkUpdateFeeds(
    [
      { source: 'mirror', url: 'https://dl.example.com/nightly' },
      { source: 'mirror', url: 'https://dl.example.com/stable' },
      { source: 'github' }
    ],
    async (feed) => {
      checked.push(feed.source === 'mirror' ? feed.url : feed.source)
      if (feed.source === 'mirror' && feed.url.endsWith('/nightly')) {
        return { available: false, version: '1.5.3-beta.202608260038' }
      }
      return { available: true, version: '1.5.3' }
    }
  )

  assert.deepEqual(result, { available: true, version: '1.5.3' })
  assert.deepEqual(checked, ['https://dl.example.com/nightly', 'https://dl.example.com/stable'])
})

test('resolveUpdateFeed probes latest.yml for Windows NSIS updates', async () => {
  const calls: string[] = []
  const feed = await resolveUpdateFeed({
    mirrorBase: 'https://dl.example.com',
    channel: 'stable',
    platform: 'win32',
    fetchFn: okFetch(calls)
  })

  assert.deepEqual(feed, { source: 'mirror', url: 'https://dl.example.com/stable' })
  assert.deepEqual(calls, ['https://dl.example.com/stable/latest.yml'])
})

test('resolveUpdateFeed falls back to github on non-ok response', async () => {
  const feed = await resolveUpdateFeed({
    mirrorBase: 'https://dl.example.com',
    channel: 'stable',
    platform: 'darwin',
    fetchFn: async () => ({ ok: false })
  })
  assert.deepEqual(feed, { source: 'github' })
})

test('resolveUpdateFeed falls back to github when the probe throws', async () => {
  const feed = await resolveUpdateFeed({
    mirrorBase: 'https://dl.example.com',
    channel: 'stable',
    platform: 'darwin',
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
    platform: 'darwin',
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
    platform: 'darwin',
    fetchFn: okFetch(calls)
  })
  assert.deepEqual(feed, { source: 'github' })
  assert.deepEqual(calls, [])
})
