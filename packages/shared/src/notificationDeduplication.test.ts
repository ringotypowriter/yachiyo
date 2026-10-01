import assert from 'node:assert/strict'
import test from 'node:test'
import { createNotificationDeduplicator } from './notificationDeduplication.ts'

test('accepts a keyed notification only once across callers and elapsed time', () => {
  const accept = createNotificationDeduplicator()
  const originalNow = Date.now
  try {
    Date.now = () => 0
    assert.equal(accept('thread:run.completed:run'), true)
    Date.now = () => 60_000
    assert.equal(accept('thread:run.completed:run'), false)
    assert.equal(accept('thread:run.completed:other'), true)
    assert.equal(accept('other-thread:run.completed:run'), true)
  } finally {
    Date.now = originalNow
  }
})

test('unkeyed notifications remain independent', () => {
  const accept = createNotificationDeduplicator()
  assert.equal(accept(), true)
  assert.equal(accept(), true)
})

test('retains only the latest 1024 notification identities', () => {
  const accept = createNotificationDeduplicator()
  assert.equal(accept('oldest'), true)
  for (let i = 0; i < 1024; i++) accept(String(i))
  assert.equal(accept('1023'), false)
  assert.equal(accept('oldest'), true)
})
