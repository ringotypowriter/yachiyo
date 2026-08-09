import assert from 'node:assert/strict'
import test from 'node:test'

import { isCreateNewThreadShortcut as isCreateNewThreadShortcutForPlatform } from './newThreadShortcut.ts'

const isCreateNewThreadShortcut = (
  event: Parameters<typeof isCreateNewThreadShortcutForPlatform>[0],
  platform = 'darwin'
): boolean => isCreateNewThreadShortcutForPlatform(event, platform)

test('isCreateNewThreadShortcut matches Cmd+N without extra modifiers', () => {
  assert.equal(
    isCreateNewThreadShortcut(
      {
        altKey: false,
        ctrlKey: false,
        key: 'n',
        metaKey: true,
        shiftKey: false
      },
      'darwin'
    ),
    true
  )

  assert.equal(
    isCreateNewThreadShortcut(
      {
        altKey: false,
        ctrlKey: false,
        key: 'N',
        metaKey: true,
        shiftKey: false
      },
      'darwin'
    ),
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

test('isCreateNewThreadShortcut uses Ctrl on Windows without accepting Ctrl+Meta ambiguity', () => {
  assert.equal(
    isCreateNewThreadShortcut(
      {
        altKey: false,
        ctrlKey: true,
        key: 'n',
        metaKey: false,
        shiftKey: false
      },
      'win32'
    ),
    true
  )
  assert.equal(
    isCreateNewThreadShortcut(
      {
        altKey: false,
        ctrlKey: true,
        key: 'n',
        metaKey: true,
        shiftKey: false
      },
      'win32'
    ),
    false
  )
})
