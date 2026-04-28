import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveThreadContextOperations } from './threadContextOperations.ts'

const THREAD_COLOR_OPERATION_KEYS = [
  'set-color-default',
  'set-color-coral',
  'set-color-azure',
  'set-color-emerald',
  'set-color-amethyst',
  'set-color-slate'
]

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
      ...THREAD_COLOR_OPERATION_KEYS,
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
      ...THREAD_COLOR_OPERATION_KEYS,
      'delete'
    ]
  )
})

test('thread context operations include title color choices for active threads', () => {
  const operations = resolveThreadContextOperations({
    colorTag: 'azure',
    isArchived: false
  })

  assert.deepEqual(
    operations
      .filter((operation) => operation.key.startsWith('set-color-'))
      .map((operation) => ({
        active: operation.active === true,
        key: operation.key
      })),
    THREAD_COLOR_OPERATION_KEYS.map((key) => ({ active: key === 'set-color-azure', key }))
  )
})

test('thread context operations omit title color choices for folder children', () => {
  const operations = resolveThreadContextOperations({
    colorTag: 'azure',
    isArchived: false,
    isInFolder: true
  })

  assert.ok(!operations.some((operation) => operation.key.startsWith('set-color-')))
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

test('thread context operations can hide handoff for normal-visible channel threads', () => {
  const operations = resolveThreadContextOperations({
    canHandoff: false,
    isArchived: false,
    isExternal: false
  })

  assert.ok(!operations.some((op) => op.key === 'compact-to-another-thread'))
  assert.deepEqual(
    operations.map((op) => op.key),
    [
      'star',
      'rename',
      'regenerate-title',
      'create-folder',
      'archive',
      ...THREAD_COLOR_OPERATION_KEYS,
      'delete'
    ]
  )
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

test('external thread operations do not include local-only actions', () => {
  const operations = resolveThreadContextOperations({
    isArchived: false,
    isExternal: true
  })

  assert.ok(!operations.some((op) => op.key === 'regenerate-title'))
  assert.ok(!operations.some((op) => op.key === 'compact-to-another-thread'))
  assert.ok(!operations.some((op) => op.key === 'archive'))
  assert.deepEqual(
    operations.map((op) => op.key),
    ['star', 'rename', ...THREAD_COLOR_OPERATION_KEYS, 'delete']
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
    ['star', 'enter-select-mode', 'rename', ...THREAD_COLOR_OPERATION_KEYS, 'delete']
  )
})
