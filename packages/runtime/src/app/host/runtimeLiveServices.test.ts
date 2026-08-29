import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimeLiveServices } from './runtimeLiveServices.ts'
import type { YachiyoServer } from './YachiyoServer.ts'

test('host shutdown closes live services and the server exactly once', async () => {
  let closeCount = 0
  const services = createRuntimeLiveServices({
    server: {
      close: async () => {
        closeCount += 1
      }
    } as YachiyoServer,
    updateReceiptLease: {} as never,
    showNotification: () => {},
    tempWorkspaceDir: '/tmp/yachiyo-runtime-live-services-test',
    enableSchedules: false,
    enableChannels: false
  })
  const shutdown = services.rpcOps['host.shutdownRuntime'] as (() => Promise<void>) | undefined

  assert.ok(shutdown)
  await shutdown()
  await shutdown()

  assert.equal(closeCount, 1)
})
