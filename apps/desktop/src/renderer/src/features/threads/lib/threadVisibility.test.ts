import assert from 'node:assert/strict'
import test from 'node:test'

import type { Thread } from '../../../app/types.ts'
import { isExternalThread, isSyncedArchiveThread } from './threadVisibility.ts'

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: 't1',
    title: 'Thread',
    updatedAt: '2026-06-18T00:00:00.000Z',
    ...overrides
  } as Thread
}

test('isSyncedArchiveThread is true only when syncOriginDeviceId is set', () => {
  assert.equal(isSyncedArchiveThread(thread({ syncOriginDeviceId: 'mac-b' })), true)
  assert.equal(isSyncedArchiveThread(thread({})), false)
})

test('synced local archives stay out of the channel/external pool', () => {
  // A normal local conversation mirrored from another device keeps source 'local',
  // so it remains in the main thread list — not lumped into the channel pool.
  const synced = thread({ source: 'local', syncOriginDeviceId: 'mac-b' })
  assert.equal(isExternalThread(synced), false)
  assert.equal(isSyncedArchiveThread(synced), true)
})
