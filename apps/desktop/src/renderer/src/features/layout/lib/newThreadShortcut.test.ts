import assert from 'node:assert/strict'
import test from 'node:test'

import { isCreateNewThreadShortcut } from './newThreadShortcut.ts'

test('isCreateNewThreadShortcut matches Cmd+N without extra modifiers', () => {
  assert.equal(
    isCreateNewThreadShortcut({
      altKey: false,
      ctrlKey: false,
      key: 'n',
      metaKey: true,
      shiftKey: false
    }),
    true
  )

  assert.equal(
    isCreateNewThreadShortcut({
      altKey: false,
      ctrlKey: false,
      key: 'N',
      metaKey: true,
      shiftKey: false
    }),
    true
  )
})

test('isCreateNewThreadShortcut rejects other modifier combinations', () => {
  assert.equal(
    isCreateNewThreadShortcut({
      altKey: false,
      ctrlKey: false,
      key: 'n',
      metaKey: false,
      shiftKey: false
    }),
    false
  )

  assert.equal(
    isCreateNewThreadShortcut({
      altKey: true,
      ctrlKey: false,
      key: 'n',
      metaKey: true,
      shiftKey: false
    }),
    false
  )

  assert.equal(
    isCreateNewThreadShortcut({
      altKey: false,
      ctrlKey: true,
      key: 'n',
      metaKey: true,
      shiftKey: false
    }),
    false
  )

  assert.equal(
    isCreateNewThreadShortcut({
      altKey: false,
      ctrlKey: false,
      key: 'n',
      metaKey: true,
      shiftKey: true
    }),
    false
  )

  assert.equal(
    isCreateNewThreadShortcut({
      altKey: false,
      ctrlKey: false,
      key: 'k',
      metaKey: true,
      shiftKey: false
    }),
    false
  )
})
