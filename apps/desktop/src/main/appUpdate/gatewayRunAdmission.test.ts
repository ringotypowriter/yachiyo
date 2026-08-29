import assert from 'node:assert/strict'
import test from 'node:test'

import { createGatewayRunAdmission } from './gatewayRunAdmission.ts'

test('utility open failure clears inherited owner and recovers without replacing the install error', async () => {
  const runtime = { id: 'runtime-1' }
  const errors: string[] = []
  let recovered = false
  const admission = createGatewayRunAdmission({
    closeRuntime: async () => ['run-1'],
    getRuntime: () => runtime,
    openRuntime: async () => {
      throw new Error('utility RPC rejected')
    },
    recoverRuntime: (attemptedRuntime) => {
      assert.equal(admission.getOwnerId(), undefined)
      assert.equal(attemptedRuntime, runtime)
      recovered = true
    },
    onOpenError: (error) => errors.push((error as Error).message)
  })

  assert.deepEqual(await admission.closeRunAdmissionAndGetActiveRunIds('install-1'), ['run-1'])
  await assert.doesNotReject(() => admission.openRunAdmission('install-1'))

  assert.equal(admission.getOwnerId(), undefined)
  assert.equal(recovered, true)
  assert.deepEqual(errors, ['utility RPC rejected'])
})

test('foreign owner cannot open or recover the winning attempt gate', async () => {
  const events: string[] = []
  const admission = createGatewayRunAdmission({
    closeRuntime: async () => [],
    getRuntime: () => ({ id: 'runtime-1' }),
    openRuntime: async () => {
      events.push('open')
    },
    recoverRuntime: () => events.push('recover'),
    onOpenError: () => events.push('error')
  })

  await admission.closeRunAdmissionAndGetActiveRunIds('install-winner')
  await admission.openRunAdmission('install-loser')

  assert.equal(admission.getOwnerId(), 'install-winner')
  assert.deepEqual(events, [])
})
