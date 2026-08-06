import assert from 'node:assert/strict'
import test from 'node:test'

import { waitForManagedChannelServiceReady } from './channelServiceReadiness.ts'

test('waits through a started but unhealthy service until it is actually healthy', async () => {
  let healthy = false
  let checks = 0
  let settled = false
  const service = {
    start: () => undefined,
    stop: () => undefined,
    async healthCheck() {
      checks += 1
      return healthy
    }
  }

  const waiting = waitForManagedChannelServiceReady({
    getService: () => service,
    retryDelayMs: 5
  }).then(() => {
    settled = true
  })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false, 'service existence/start is not enough')
  assert.ok(checks > 0)

  healthy = true
  await waiting
  assert.equal(settled, true)
})

test('waits for the target service to exist instead of treating startup as ready', async () => {
  let service: {
    start(): void
    stop(): void
    healthCheck(): Promise<boolean>
  } | null = null

  const waiting = waitForManagedChannelServiceReady({
    getService: () => service,
    retryDelayMs: 5
  })
  await new Promise((resolve) => setTimeout(resolve, 15))

  service = {
    start: () => undefined,
    stop: () => undefined,
    healthCheck: async () => true
  }
  await waiting
})

test('stopping live services cancels an outstanding channel readiness wait', async () => {
  const controller = new AbortController()
  const waiting = waitForManagedChannelServiceReady({
    getService: () => null,
    retryDelayMs: 60_000,
    signal: controller.signal
  })

  controller.abort(new Error('live services stopped'))
  await assert.rejects(waiting, { name: 'AbortError', message: 'Aborted' })
})

test('a late healthy result cannot revive a readiness wait after shutdown', async () => {
  const controller = new AbortController()
  let finishHealthCheck: ((healthy: boolean) => void) | undefined
  const waiting = waitForManagedChannelServiceReady({
    getService: () => ({
      start: () => undefined,
      stop: () => undefined,
      healthCheck: () =>
        new Promise<boolean>((resolve) => {
          finishHealthCheck = resolve
        })
    }),
    signal: controller.signal
  })

  await Promise.resolve()
  controller.abort(new Error('live services stopped'))
  finishHealthCheck!(true)

  await assert.rejects(waiting, /live services stopped/)
})
