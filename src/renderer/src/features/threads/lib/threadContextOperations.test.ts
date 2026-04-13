import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveThreadContextOperations } from './threadContextOperations.ts'

test('thread context operations omit select mode by default', () => {
  assert.deepEqual(
    resolveThreadContextOperations({
      isArchived: false
    }).map((operation) => operation.key),
    [
      'star',
      'rename',
      'regenerate-title',
      'compact-to-another-thread',
      'create-folder',
      'archive',
      'delete'
    ]
  )
})

test('thread context operations include select mode when requested', () => {
  assert.deepEqual(
    resolveThreadContextOperations({
      includeSelectMode: true,
      isArchived: false
    }).map((operation) => operation.key),
    [
      'star',
      'enter-select-mode',
      'rename',
      'regenerate-title',
      'compact-to-another-thread',
      'create-folder',
      'archive',
      'delete'
    ]
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

test('thread context operations disable handoff when a run is active', () => {
  const operations = resolveThreadContextOperations({
    isArchived: false,
    isRunning: true
  })

  const handoffOperation = operations.find((op) => op.key === 'compact-to-another-thread')
  assert.equal(handoffOperation?.disabled, true)

  const otherOperations = operations.filter((op) => op.key !== 'compact-to-another-thread')
  assert.ok(otherOperations.every((op) => !op.disabled))
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

test('archived thread operations include select mode when requested', () => {
  const operations = resolveThreadContextOperations({
    includeSelectMode: true,
    isArchived: true
  })

  assert.deepEqual(
    operations.map((op) => op.key),
    ['enter-select-mode', 'restore', 'delete']
  )
})

test('external thread operations do not include regenerate-title or archive', () => {
  const operations = resolveThreadContextOperations({
    isArchived: false,
    isExternal: true
  })

  assert.ok(!operations.some((op) => op.key === 'regenerate-title'))
  assert.ok(!operations.some((op) => op.key === 'archive'))
  assert.deepEqual(
    operations.map((op) => op.key),
    ['star', 'rename', 'compact-to-another-thread', 'delete']
  )
})

test('external thread operations include select mode when requested', () => {
  const operations = resolveThreadContextOperations({
    includeSelectMode: true,
    isArchived: false,
    isExternal: true
  })

  assert.deepEqual(
    operations.map((op) => op.key),
    ['star', 'enter-select-mode', 'rename', 'compact-to-another-thread', 'delete']
  )
})
