import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveThreadContextOperations } from './threadContextOperations.ts'

test('thread context operations only expose Save Thread when memory is enabled', () => {
  assert.deepEqual(
    resolveThreadContextOperations({
      isArchived: false,
      isMemoryEnabled: true
    }).map((operation) => operation.key),
    [
      'star',
      'rename',
      'regenerate-title',
      'compact-to-another-thread',
      'save-thread',
      'archive',
      'delete'
    ]
  )

  assert.deepEqual(
    resolveThreadContextOperations({
      isArchived: false,
      isMemoryEnabled: false
    }).map((operation) => operation.key),
    ['star', 'rename', 'regenerate-title', 'compact-to-another-thread', 'archive', 'delete']
  )
})

test('thread context operations omit Save Thread when the caller disables memory actions', () => {
  assert.ok(
    !resolveThreadContextOperations({
      isArchived: false,
      isMemoryEnabled: false
    }).some((operation) => operation.key === 'save-thread')
  )
})

test('thread context operations use the short handoff label for compacting into another thread', () => {
  const handoffOperation = resolveThreadContextOperations({
    isArchived: false,
    isMemoryEnabled: false
  }).find((operation) => operation.key === 'compact-to-another-thread')

  assert.equal(handoffOperation?.label, 'Handoff')
})

test('thread context operations disable all operations while saving', () => {
  const operations = resolveThreadContextOperations({
    isArchived: false,
    isMemoryEnabled: true,
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

test('thread context operations show Saving… label for save-thread while saving', () => {
  const saveOp = resolveThreadContextOperations({
    isArchived: false,
    isMemoryEnabled: true,
    isSaving: true
  }).find((op) => op.key === 'save-thread')

  assert.equal(saveOp?.label, 'Saving…')
})

test('thread context operations do not disable operations when isSaving is false', () => {
  const operations = resolveThreadContextOperations({
    isArchived: false,
    isMemoryEnabled: true,
    isSaving: false
  })

  assert.ok(operations.every((op) => !op.disabled))
})
