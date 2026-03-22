import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveThreadContextOperations } from './threadContextOperations.ts'

test('thread context operations only expose Save Thread when memory is enabled', () => {
  assert.deepEqual(
    resolveThreadContextOperations({
      isArchived: false,
      isMemoryEnabled: true
    }).map((operation) => operation.key),
    ['rename', 'compact-to-another-thread', 'save-thread', 'archive', 'delete']
  )

  assert.deepEqual(
    resolveThreadContextOperations({
      isArchived: false,
      isMemoryEnabled: false
    }).map((operation) => operation.key),
    ['rename', 'compact-to-another-thread', 'archive', 'delete']
  )
})

test('thread context operations use the short handoff label for compacting into another thread', () => {
  const handoffOperation = resolveThreadContextOperations({
    isArchived: false,
    isMemoryEnabled: false
  }).find((operation) => operation.key === 'compact-to-another-thread')

  assert.equal(handoffOperation?.label, 'Handoff')
})
