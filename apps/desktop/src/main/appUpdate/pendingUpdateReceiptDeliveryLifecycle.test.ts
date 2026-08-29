import assert from 'node:assert/strict'
import test from 'node:test'

import { createPendingUpdateReceiptDeliveryLifecycle } from './pendingUpdateReceiptDeliveryLifecycle.ts'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('a replacement runtime retries delivery only after the crashed runtime attempt settles', async () => {
  const first = deferred()
  const second = deferred()
  let calls = 0
  let active = 0
  let maxActive = 0
  const errors: unknown[] = []
  const lifecycle = createPendingUpdateReceiptDeliveryLifecycle({
    deliver: async () => {
      calls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        await (calls === 1 ? first.promise : second.promise)
      } finally {
        active -= 1
      }
    },
    onDeliveryError: (error) => errors.push(error)
  })

  const initialDelivery = lifecycle.requestDelivery()
  await Promise.resolve()
  const replacementDelivery = lifecycle.requestDelivery()
  await Promise.resolve()

  assert.equal(calls, 1, 'the replacement must not deliver concurrently with the old runtime')
  first.reject(new Error('runtime exited'))
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(calls, 2, 'the replacement runtime retries the interrupted readiness wait')
  assert.equal(maxActive, 1)
  second.resolve()
  await Promise.all([initialDelivery, replacementDelivery])
  assert.equal((errors[0] as Error).message, 'runtime exited')
})

test('multiple runtime lifecycle signals coalesce into one replacement attempt', async () => {
  const first = deferred()
  const second = deferred()
  let calls = 0
  const lifecycle = createPendingUpdateReceiptDeliveryLifecycle({
    deliver: async () => {
      calls += 1
      await (calls === 1 ? first.promise : second.promise)
    },
    onDeliveryError: () => {}
  })

  const initialDelivery = lifecycle.requestDelivery()
  await Promise.resolve()
  const intentionalRestart = lifecycle.requestDelivery()
  const repeatedExitSignal = lifecycle.requestDelivery()
  first.reject(new Error('runtime stopped'))
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(calls, 2)
  second.resolve()
  await Promise.all([initialDelivery, intentionalRestart, repeatedExitSignal])
  assert.equal(calls, 2, 'one runtime generation gets at most one queued retry')
})
