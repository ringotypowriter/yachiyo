import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReadPendingUpdateReceipt } from './pendingUpdateReceipt.ts'
import { createUpdateReceiptCoordinator } from './updateReceiptCoordinator.ts'

const receipt: ReadPendingUpdateReceipt = {
  attemptId: 'attempt-1',
  channelId: 'chan-1',
  threadId: 'thread-1',
  messageId: 'msg-1',
  fromVersion: '1.0.0',
  targetVersion: '1.1.0',
  startedAtMs: 1_760_000_000_000
}

function coordinator(overrides: { record?: ReadPendingUpdateReceipt | undefined } = {}): {
  instance: ReturnType<typeof createUpdateReceiptCoordinator>
  cleared: string[]
  stillStored: () => boolean
} {
  let stored: ReadPendingUpdateReceipt | undefined =
    'record' in overrides ? overrides.record : receipt
  const cleared: string[] = []
  let tokens = 0

  const instance = createUpdateReceiptCoordinator({
    read: () => stored,
    clear: (attemptId) => {
      cleared.push(attemptId)
      if (stored?.attemptId === attemptId) stored = undefined
    },
    describe: (found) => `已更新到 ${found.targetVersion}`,
    newToken: () => `token-${++tokens}`
  })
  return { instance, cleared, stillStored: (): boolean => stored !== undefined }
}

/** Gate 1: while the active send may still deliver, nobody else may carry it. */
test('nothing is claimable before the active send has failed', () => {
  const { instance } = coordinator()
  assert.equal(instance.claim('chan-1'), undefined)
})

test('a deferred receipt becomes claimable with its rendered message', () => {
  const { instance } = coordinator()
  instance.defer('attempt-1')

  const claim = instance.claim('chan-1')
  assert.ok(claim)
  assert.equal(claim.message, '已更新到 1.1.0')
})

test('a deferred attempt cannot re-enter active delivery after a runtime refork', () => {
  const { instance } = coordinator()
  assert.equal(instance.canActivelyDeliver('attempt-1'), true)

  instance.defer('attempt-1')

  assert.equal(instance.canActivelyDeliver('attempt-1'), false)
  assert.equal(instance.canActivelyDeliver('attempt-2'), true)
})

/** Gate 2: two concurrent outbounds must not both carry the receipt. */
test('only one concurrent claim succeeds', () => {
  const { instance } = coordinator()
  instance.defer('attempt-1')

  const first = instance.claim('chan-1')
  const second = instance.claim('chan-1')
  assert.ok(first)
  assert.equal(second, undefined, 'a second outbound must not also carry it')
})

/** Gate 3: once delivered and acknowledged, it is never prepended again. */
test('an acknowledged claim clears the record and cannot be claimed again', () => {
  const { instance, cleared, stillStored } = coordinator()
  instance.defer('attempt-1')

  const claim = instance.claim('chan-1')
  assert.ok(claim)
  instance.ack(claim.claimToken)

  assert.deepEqual(cleared, ['attempt-1'])
  assert.equal(stillStored(), false)
  assert.equal(instance.claim('chan-1'), undefined)
})

/** Gate 4: a failed send returns the lease; the receipt is still owed. */
test('a released claim leaves the record for the next outbound', () => {
  const { instance, cleared, stillStored } = coordinator()
  instance.defer('attempt-1')

  const first = instance.claim('chan-1')
  assert.ok(first)
  instance.release(first.claimToken)

  assert.deepEqual(cleared, [], 'a failed send must not clear anything')
  assert.equal(stillStored(), true)

  const second = instance.claim('chan-1')
  assert.ok(second, 'the next outbound can carry it')
  assert.notEqual(second.claimToken, first.claimToken)
})

/** Gate 5: a runtime that dies holding a lease must not lock the receipt forever. */
test('releasing all claims frees a lease abandoned by a dead runtime', () => {
  const { instance, stillStored } = coordinator()
  instance.defer('attempt-1')

  const abandoned = instance.claim('chan-1')
  assert.ok(abandoned)
  assert.equal(instance.claim('chan-1'), undefined, 'locked while the lease is live')

  instance.releaseAllClaims()

  assert.equal(stillStored(), true)
  assert.ok(instance.claim('chan-1'), 'claimable again once the holder is gone')
})

test('a stale token cannot acknowledge or release somebody else’s claim', () => {
  const { instance, cleared, stillStored } = coordinator()
  instance.defer('attempt-1')
  const claim = instance.claim('chan-1')
  assert.ok(claim)

  instance.ack('not-my-token')
  instance.release('not-my-token')

  assert.deepEqual(cleared, [], 'the real holder still owns it')
  assert.equal(stillStored(), true)
})

test('a receipt owed to a different channel is not offered here', () => {
  const { instance } = coordinator()
  instance.defer('attempt-1')
  assert.equal(instance.claim('some-other-channel'), undefined)
})

test('nothing is claimable when no record exists', () => {
  const { instance } = coordinator({ record: undefined })
  instance.defer('attempt-1')
  assert.equal(instance.claim('chan-1'), undefined)
})

/** A record replaced by a newer attempt must not be delivered under the old one. */
test('a deferral does not apply to a record written by a later attempt', () => {
  const { instance } = coordinator()
  instance.defer('an-older-attempt')
  assert.equal(instance.claim('chan-1'), undefined)
})
