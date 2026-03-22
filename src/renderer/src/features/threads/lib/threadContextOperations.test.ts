import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveThreadContextOperations } from './threadContextOperations.ts'

test('thread context operations only expose Save Thread when memory is enabled', () => {
  assert.deepEqual(
    resolveThreadContextOperations({
      isArchived: false,
      isMemoryEnabled: true
    }).map((operation) => operation.key),
    ['rename', 'save-thread', 'archive', 'delete']
  )

  assert.deepEqual(
    resolveThreadContextOperations({
      isArchived: false,
      isMemoryEnabled: false
    }).map((operation) => operation.key),
    ['rename', 'archive', 'delete']
  )
})
