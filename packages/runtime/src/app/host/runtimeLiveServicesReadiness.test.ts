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
  const readiness = createRuntimeLiveServicesReadiness(
    () => {
      startCalls += 1
      return startup
    },
    () => Promise.resolve()
  )
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

test('runtime startup still runs when post-start work has nothing to do', async () => {
  let started = false
  let workCalls = 0

  await runAfterRuntimeLiveServicesReady(
    async () => {
      started = true
    },
    async () => {
      assert.equal(started, true)
      workCalls += 1
    }
  )

  assert.equal(workCalls, 1)
})

test('channel readiness waits for startup and then for the actual channel health gate', async () => {
  let finishStartup: (() => void) | undefined
  let markChannelHealthy: (() => void) | undefined
  const events: string[] = []
  const readiness = createRuntimeLiveServicesReadiness(
    () =>
      new Promise<void>((resolve) => {
        events.push('start')
        finishStartup = resolve
      }),
    (channelId) =>
      new Promise<void>((resolve) => {
        events.push(`health:${channelId}`)
        markChannelHealthy = resolve
      })
  )
  let ready = false

  const waiting = readiness.waitForChannelReady('chan-1').then(() => {
    ready = true
  })
  await Promise.resolve()
  assert.deepEqual(events, ['start'])
  assert.equal(ready, false)

  finishStartup!()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ['start', 'health:chan-1'])
  assert.equal(ready, false, '`start()` completing is not a channel health signal')

  markChannelHealthy!()
  await waiting
  assert.equal(ready, true)
})
