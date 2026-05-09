import assert from 'node:assert/strict'
import test from 'node:test'

import { selectComposerPlaceholder } from './composerPlaceholder.ts'

test('selectComposerPlaceholder keeps the same placeholder for the same thread seed', () => {
  const candidates = ['alpha', 'bravo', 'charlie', 'delta']

  assert.equal(
    selectComposerPlaceholder('thread-42', candidates),
    selectComposerPlaceholder('thread-42', candidates)
  )
})

test('selectComposerPlaceholder varies placeholders across different thread seeds', () => {
  const candidates = ['alpha', 'bravo', 'charlie', 'delta']
  const selected = new Set(
    ['thread-1', 'thread-2', 'thread-3', 'thread-4'].map((seed) =>
      selectComposerPlaceholder(seed, candidates)
    )
  )

  assert.ok(selected.size > 1)
})

test('selectComposerPlaceholder uses the first placeholder before a thread exists', () => {
  assert.equal(selectComposerPlaceholder(null, ['alpha', 'bravo']), 'alpha')
})

test('selectComposerPlaceholder rejects an empty placeholder list', () => {
  assert.throws(() => selectComposerPlaceholder('thread-42', []), /requires at least one candidate/)
})
