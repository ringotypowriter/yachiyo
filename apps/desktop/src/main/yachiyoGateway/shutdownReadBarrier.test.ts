import assert from 'node:assert/strict'
import test from 'node:test'
import { createLoopbackRpcHost } from '@yachiyo/shared/rpc/loopbackRpcHost'

import { createShutdownReadBarrier } from './shutdownReadBarrier.ts'

test('drains started RPC reads and blocks new reads before transport disposal', async () => {
  const barrier = createShutdownReadBarrier()
  const pendingRead = Promise.withResolvers<string[]>()
  const readStarted = Promise.withResolvers<void>()
  let readCount = 0
  let transportDisposed = false
  const host = createLoopbackRpcHost({
    async listBackgroundTasks(): Promise<string[]> {
      readCount += 1
      readStarted.resolve()
      return pendingRead.promise
    }
  })

  const firstRead = barrier.run(
    () => host.proxy.listBackgroundTasks(),
    () => []
  )
  await readStarted.promise
  const shutdown = barrier.beginShutdown().then(() => {
    host.dispose()
    transportDisposed = true
  })

  await Promise.resolve()
  assert.equal(transportDisposed, false)

  const stoppedRead = await barrier.run(
    () => {
      readCount += 1
      return Promise.resolve(['unexpected'])
    },
    () => []
  )
  assert.deepEqual(stoppedRead, [])
  assert.equal(readCount, 1)

  pendingRead.resolve(['task'])
  assert.deepEqual(await firstRead, ['task'])
  await shutdown

  assert.equal(transportDisposed, true)
})
