import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRuntimeLiveServicesReadiness,
  runAfterRuntimeLiveServicesReady
} from './runtimeLiveServicesReadiness.ts'

test('start and waitForReady share one startup and settle only when it finishes', async () => {
  let startCalls = 0
  let finishStartup: (() => void) | undefined
  const startup = new Promise<void>((resolve) => {
    finishStartup = resolve
  })
  const readiness = createRuntimeLiveServicesReadiness(() => {
    startCalls += 1
    return startup
  })
  let ready = false

  const waiting = readiness.waitForReady().then(() => {
    ready = true
  })
  const starting = readiness.start()
  await Promise.resolve()

  assert.equal(startCalls, 1, 'both callers must share the same startup')
  assert.equal(ready, false, 'the ready signal must not run ahead of startup')

  finishStartup!()
  await Promise.all([waiting, starting])
  assert.equal(ready, true)
})

test('post-start work cannot run before live services are ready', async () => {
  let finishStartup: (() => void) | undefined
  const readiness = createRuntimeLiveServicesReadiness(
    () =>
      new Promise<void>((resolve) => {
        finishStartup = resolve
      })
  )
  const events: string[] = []

  const delivery = runAfterRuntimeLiveServicesReady(readiness.waitForReady, async () => {
    events.push('deliver')
  })
  await Promise.resolve()
  assert.deepEqual(events, [], 'delivery must stay blocked while startup is incomplete')

  finishStartup!()
  await delivery
  assert.deepEqual(events, ['deliver'])
})
