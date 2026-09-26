import assert from 'node:assert/strict'
import test from 'node:test'
import { useContentReaderStore } from './useContentReaderStore.ts'
import { startPreviewResourceLifecycle } from './previewResourceLifecycle.ts'

test('closing a web tab immediately releases only that session and lifecycle disposal removes timers', async () => {
  useContentReaderStore.setState(useContentReaderStore.getInitialState(), true)
  const releases: unknown[] = []
  let tick: (() => void) | undefined
  let cleared = false
  const stop = startPreviewResourceLifecycle({
    release: async (input) => {
      releases.push(input)
      return { released: true }
    },
    clock: () => 0,
    every: (callback) => {
      tick = callback
      return () => {
        cleared = true
      }
    }
  })
  useContentReaderStore
    .getState()
    .open({ kind: 'web', threadId: 'a', session: 'user', url: 'https://example.com' })
  useContentReaderStore.getState().close()
  await Promise.resolve()
  assert.deepEqual(releases, [{ threadId: 'a', session: 'user', mode: 'close' }])
  assert.ok(tick)
  stop()
  assert.equal(cleared, true)
})
