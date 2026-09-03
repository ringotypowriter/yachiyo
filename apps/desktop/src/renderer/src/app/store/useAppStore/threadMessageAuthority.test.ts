import assert from 'node:assert/strict'
import test from 'node:test'

import { bumpThreadMessageAuthority, isThreadMessageReadStale } from './threadMessageAuthority.ts'

test('a read issued before any authoritative write is still current', () => {
  // A thread nobody has synced yet has no entry at all; that absence must not
  // read as a change, or every ordinary open would discard its own result.
  assert.equal(isThreadMessageReadStale({ captured: undefined, current: undefined }), false)
})

test('a read is stale once the thread it read has been replaced', () => {
  const after = bumpThreadMessageAuthority({}, 'thread-1')

  assert.equal(isThreadMessageReadStale({ captured: undefined, current: after['thread-1'] }), true)
})

test('a write to one thread does not invalidate reads of another', () => {
  const after = bumpThreadMessageAuthority({ 'thread-1': 3 }, 'thread-2')

  assert.equal(isThreadMessageReadStale({ captured: 3, current: after['thread-1'] }), false)
  assert.equal(after['thread-2'], 1)
})

test('successive replacements keep invalidating', () => {
  let authority = bumpThreadMessageAuthority({}, 'thread-1')
  const captured = authority['thread-1']
  authority = bumpThreadMessageAuthority(authority, 'thread-1')

  assert.equal(isThreadMessageReadStale({ captured, current: authority['thread-1'] }), true)
})
