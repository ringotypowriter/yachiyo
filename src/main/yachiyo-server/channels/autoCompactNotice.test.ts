import assert from 'node:assert/strict'
import test from 'node:test'

import { AUTO_COMPACT_NOTICE, notifyAutoCompact } from './autoCompactNotice.ts'

test('notifyAutoCompact sends the compact notice once', async () => {
  const calls: Array<{ target: string; text: string }> = []

  await notifyAutoCompact(async (target, text) => {
    calls.push({ target, text })
  }, 'chat-123')

  assert.deepEqual(calls, [{ target: 'chat-123', text: AUTO_COMPACT_NOTICE }])
})

test('notifyAutoCompact ignores send failures', async () => {
  await notifyAutoCompact(async () => {
    throw new Error('boom')
  }, 'chat-123')
})
