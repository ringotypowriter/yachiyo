import assert from 'node:assert/strict'
import test from 'node:test'

import { selectComposerPlaceholder } from './composerPlaceholder.ts'

test('selectComposerPlaceholder keeps the same placeholder for the same thread and run seed', () => {
  const candidates = ['alpha', 'bravo', 'charlie', 'delta']

  assert.equal(
    selectComposerPlaceholder({ threadId: 'thread-42', runId: 'run-1' }, candidates),
    selectComposerPlaceholder({ threadId: 'thread-42', runId: 'run-1' }, candidates)
  )
})

test('selectComposerPlaceholder varies placeholders across different thread seeds', () => {
  const candidates = ['alpha', 'bravo', 'charlie', 'delta']
  const selected = new Set(
    ['thread-1', 'thread-2', 'thread-3', 'thread-4'].map((seed) =>
      selectComposerPlaceholder({ threadId: seed }, candidates)
    )
  )

  assert.ok(selected.size > 1)
})

test('selectComposerPlaceholder varies placeholders across different run seeds in the same thread', () => {
  const candidates = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
  const runIds = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5', 'run-6', 'run-7', 'run-8']
  const selected = new Set(
    runIds.map((runId) => selectComposerPlaceholder({ threadId: 'thread-42', runId }, candidates))
  )

  assert.equal(selected.size, runIds.length)
})

test('selectComposerPlaceholder advances placeholders by run index when run order is available', () => {
  const candidates = ['alpha', 'bravo', 'charlie', 'delta']
  const selected = new Set(
    [0, 1, 2, 3].map((runIndex) =>
      selectComposerPlaceholder({ threadId: 'thread-42', runIndex }, candidates)
    )
  )

  assert.equal(selected.size, candidates.length)
})

test('selectComposerPlaceholder uses the first placeholder before a thread exists', () => {
  assert.equal(
    selectComposerPlaceholder({ threadId: null, runId: 'run-1' }, ['alpha', 'bravo']),
    'alpha'
  )
})

test('selectComposerPlaceholder rejects an empty placeholder list', () => {
  assert.throws(
    () => selectComposerPlaceholder({ threadId: 'thread-42', runId: 'run-1' }, []),
    /requires at least one candidate/
  )
})
