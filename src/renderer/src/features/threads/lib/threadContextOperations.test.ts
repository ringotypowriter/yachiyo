import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveThreadContextOperations } from './threadContextOperations.ts'

test('thread context operations for active threads include expected keys', () => {
  assert.deepEqual(
    resolveThreadContextOperations({
      isArchived: false
    }).map((operation) => operation.key),
    ['star', 'rename', 'regenerate-title', 'compact-to-another-thread', 'archive', 'delete']
  )
})

test('thread context operations use the short handoff label for compacting into another thread', () => {
  const handoffOperation = resolveThreadContextOperations({
    isArchived: false
  }).find((operation) => operation.key === 'compact-to-another-thread')

  assert.equal(handoffOperation?.label, 'Handoff')
})

test('thread context operations disable all operations while saving', () => {
  const operations = resolveThreadContextOperations({
    isArchived: false,
    isSaving: true
  })

  assert.ok(operations.every((op) => op.disabled === true))
})

test('thread context operations disable all archived-thread operations while saving', () => {
  const operations = resolveThreadContextOperations({
    isArchived: true,
    isSaving: true
  })

  assert.ok(operations.every((op) => op.disabled === true))
})

test('thread context operations do not disable operations when isSaving is false', () => {
  const operations = resolveThreadContextOperations({
    isArchived: false,
    isSaving: false
  })

  assert.ok(operations.every((op) => !op.disabled))
})

test('archived thread operations do not include regenerate-title', () => {
  const operations = resolveThreadContextOperations({
    isArchived: true
  })

  assert.ok(!operations.some((op) => op.key === 'regenerate-title'))
  assert.deepEqual(
    operations.map((op) => op.key),
    ['restore', 'delete']
  )
})
