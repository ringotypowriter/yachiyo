import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ProcessBroker,
  ProcessJob
} from '@yachiyo/runtime/services/processBroker/processBroker'
import { createRuntimeHostServer } from './runtimeHostStartup.ts'

class ControllableProcessBroker implements ProcessBroker {
  closeCount = 0
  startCount = 0
  startError?: Error

  start(): Promise<void> {
    this.startCount += 1
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

test('createRuntimeHostServer keeps the process broker lazy during app startup', async () => {
  const broker = new ControllableProcessBroker()
  const server = { close: () => Promise.resolve() }

  const created = await createRuntimeHostServer({
    createProcessBroker: () => broker,
    createServer: (processBroker) => {
      assert.equal(processBroker, broker)
      return server
    }
  })

  assert.equal(created, server)
  assert.equal(broker.startCount, 0)
  assert.equal(broker.closeCount, 0)
})

test('createRuntimeHostServer closes its lazy broker when server construction throws', async () => {
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
  assert.equal(broker.startCount, 0)
  assert.equal(broker.closeCount, 1)
})
