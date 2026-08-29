import assert from 'node:assert/strict'
import test from 'node:test'

import { reopenOwnedRunAdmission } from './runAdmissionReopen.ts'

test('a failed utility open clears ownership before recovering the runtime', async () => {
  let ownerId: string | undefined = 'install-1'
  const events: string[] = []

  await reopenOwnedRunAdmission({
    ownsAdmission: () => ownerId === 'install-1',
    clearOwner: () => {
      ownerId = undefined
      events.push('clear-owner')
    },
    openRuntime: async () => {
      events.push('open-runtime')
      throw new Error('utility crashed')
    },
    recoverRuntime: () => {
      assert.equal(ownerId, undefined, 'the replacement must inherit an open admission state')
      events.push('recover-runtime')
    },
    onOpenError: (error) => events.push(`error:${(error as Error).message}`)
  })

  assert.equal(ownerId, undefined)
  assert.deepEqual(events, [
    'clear-owner',
    'open-runtime',
    'error:utility crashed',
    'recover-runtime'
  ])
})

test('a foreign owner cannot open or recover the winning attempt admission', async () => {
  let ownerId: string | undefined = 'install-winner'
  const events: string[] = []

  await reopenOwnedRunAdmission({
    ownsAdmission: () => ownerId === 'install-loser',
    clearOwner: () => {
      ownerId = undefined
      events.push('clear-owner')
    },
    openRuntime: async () => {
      events.push('open-runtime')
    },
    recoverRuntime: () => events.push('recover-runtime'),
    onOpenError: () => events.push('error')
  })

  assert.equal(ownerId, 'install-winner')
  assert.deepEqual(events, [])
})
