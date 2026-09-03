import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bumpThreadMessageAuthority,
  isThreadDeleted,
  isThreadMessageReadStale
} from './threadMessageAuthority.ts'

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
  const before = bumpThreadMessageAuthority({}, 'thread-1')
  const after = bumpThreadMessageAuthority(before, 'thread-2')

  assert.equal(
    isThreadMessageReadStale({ captured: before['thread-1'], current: after['thread-1'] }),
    false
  )
  assert.equal(after['thread-2']?.revision, 1)
})

test('successive replacements keep invalidating', () => {
  let authority = bumpThreadMessageAuthority({}, 'thread-1')
  const captured = authority['thread-1']
  authority = bumpThreadMessageAuthority(authority, 'thread-1')

  assert.equal(isThreadMessageReadStale({ captured, current: authority['thread-1'] }), true)
})

test('a replacement leaves the thread alive, a deletion does not', () => {
  // The two reasons a read goes stale need different handling: a replaced
  // thread can still take state the replacement did not carry, a deleted one
  // must take nothing.
  const replaced = bumpThreadMessageAuthority({}, 'thread-1')
  const deleted = bumpThreadMessageAuthority(replaced, 'thread-1', { deleted: true })

  assert.equal(isThreadDeleted(replaced['thread-1']), false)
  assert.equal(isThreadDeleted(deleted['thread-1']), true)
  assert.equal(isThreadDeleted(undefined), false)
})
