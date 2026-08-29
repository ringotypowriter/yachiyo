import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deferAppQuitUntil,
  type AppQuitTarget,
  type BeforeQuitEventLike
} from './deferredAppQuit.ts'

class FakeApp implements AppQuitTarget {
  private listener: ((event: BeforeQuitEventLike) => void) | undefined
  quitCount = 0

  onBeforeQuit(listener: (event: BeforeQuitEventLike) => void): void {
    this.listener = listener
  }

  quit(): void {
    this.quitCount += 1
  }

  requestQuit(): number {
    let preventDefaultCount = 0
    this.listener?.({
      preventDefault: () => {
        preventDefaultCount += 1
      }
    })
    return preventDefaultCount
  }
}

test('defers repeated quit requests until one cleanup completes', async () => {
  const app = new FakeApp()
  const cleanup = Promise.withResolvers<void>()
  let cleanupCount = 0

  deferAppQuitUntil({
    app,
    cleanup: () => {
      cleanupCount += 1
      return cleanup.promise
    },
    onCleanupError: () => assert.fail('cleanup should not fail')
  })

  assert.equal(app.requestQuit(), 1)
  assert.equal(app.requestQuit(), 1)
  assert.equal(cleanupCount, 1)
  assert.equal(app.quitCount, 0)

  cleanup.resolve()
  await cleanup.promise
  await Promise.resolve()

  assert.equal(app.quitCount, 1)
  assert.equal(app.requestQuit(), 0)
})

test('releases the final quit when cleanup fails', async () => {
  const app = new FakeApp()
  const cleanupError = new Error('shutdown failed')
  let reported: unknown

  deferAppQuitUntil({
    app,
    cleanup: () => Promise.reject(cleanupError),
    onCleanupError: (error) => {
      reported = error
    }
  })

  assert.equal(app.requestQuit(), 1)
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(reported, cleanupError)
  assert.equal(app.quitCount, 1)
  assert.equal(app.requestQuit(), 0)
})
