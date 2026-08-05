import assert from 'node:assert/strict'
import test from 'node:test'

import type { ReadPendingUpdateReceipt } from './pendingUpdateReceipt.ts'
import { deliverPendingUpdateReceiptAfterChannelReady } from './pendingUpdateReceiptDelivery.ts'

const receipt: ReadPendingUpdateReceipt = {
  attemptId: 'attempt-1',
  channelId: 'chan-1',
  threadId: 'thread-1',
  messageId: 'msg-1',
  fromVersion: '1.0.0',
  targetVersion: '1.1.0',
  startedAtMs: 1_760_000_000_000
}

test('does not actively deliver until the receipt channel is actually healthy', async () => {
  let markHealthy: (() => void) | undefined
  let sent = false
  const cleared: string[] = []

  const delivery = deliverPendingUpdateReceiptAfterChannelReady({
    read: () => receipt,
    waitForChannelReady: (channelId) => {
      assert.equal(channelId, 'chan-1')
      return new Promise<void>((resolve) => {
        markHealthy = resolve
      })
    },
    describe: () => 'updated to 1.1.0',
    sendActive: async (input) => {
      assert.deepEqual(input, { channelId: 'chan-1', message: 'updated to 1.1.0' })
      sent = true
    },
    clear: (attemptId) => cleared.push(attemptId),
    defer: () => {}
  })

  await Promise.resolve()
  assert.equal(sent, false, '`start()` completing cannot let the send run ahead of login health')

  markHealthy!()
  await delivery
  assert.equal(sent, true)
  assert.deepEqual(cleared, ['attempt-1'])
})

test('a genuine active-send failure is deferred after the health gate', async () => {
  const deferred: string[] = []
  const errors: unknown[] = []

  await deliverPendingUpdateReceiptAfterChannelReady({
    read: () => receipt,
    waitForChannelReady: async () => {},
    describe: () => 'updated to 1.1.0',
    sendActive: async () => {
      throw new Error('active messages disabled')
    },
    clear: () => assert.fail('a failed delivery must not clear the receipt'),
    defer: (attemptId) => deferred.push(attemptId),
    onDeliveryError: (error) => errors.push(error)
  })

  assert.deepEqual(deferred, ['attempt-1'])
  assert.equal((errors[0] as Error).message, 'active messages disabled')
})

test('does not send a stale receipt that was replaced during the health wait', async () => {
  let stored: ReadPendingUpdateReceipt | undefined = receipt

  await deliverPendingUpdateReceiptAfterChannelReady({
    read: () => stored,
    waitForChannelReady: async () => {
      stored = { ...receipt, attemptId: 'attempt-2' }
    },
    describe: () => 'updated to 1.1.0',
    sendActive: async () => assert.fail('the replaced receipt must not be sent'),
    clear: () => assert.fail('the replaced receipt must not be cleared'),
    defer: () => assert.fail('the replaced receipt must not be deferred')
  })
})
