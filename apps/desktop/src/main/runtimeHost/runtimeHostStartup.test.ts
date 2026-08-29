import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ProcessBroker,
  ProcessJob
} from '@yachiyo/runtime/services/processBroker/processBroker'
import { createRuntimeHostServer } from './runtimeHostStartup.ts'

class ControllableProcessBroker implements ProcessBroker {
  closeCount = 0
  startError?: Error

  start(): Promise<void> {
    return this.startError ? Promise.reject(this.startError) : Promise.resolve()
  }

  startJob(): Promise<ProcessJob> {
    return Promise.reject(new Error('not used'))
  }

  close(): Promise<void> {
    this.closeCount += 1
    return Promise.resolve()
  }
}

test('createRuntimeHostServer closes a broker whose startup rejects', async () => {
  const broker = new ControllableProcessBroker()
  broker.startError = new Error('native host unavailable')

  await assert.rejects(
    createRuntimeHostServer({
      createProcessBroker: () => broker,
      createServer: () => ({ close: () => Promise.resolve() })
    }),
    broker.startError
  )
  assert.equal(broker.closeCount, 1)
})

test('createRuntimeHostServer closes a started broker when server construction throws', async () => {
  const broker = new ControllableProcessBroker()
  const serverError = new Error('database construction failed')

  await assert.rejects(
    createRuntimeHostServer({
      createProcessBroker: () => broker,
      createServer: () => {
        throw serverError
      }
    }),
    serverError
  )
  assert.equal(broker.closeCount, 1)
})
