import assert from 'node:assert/strict'
import test from 'node:test'

import { isOpenFindBarShortcut, isOpenSidebarSearchShortcut } from './findBarShortcut.ts'

const event = (overrides: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    altKey: false,
    ctrlKey: false,
    key: 'f',
    metaKey: false,
    shiftKey: false,
    ...overrides
  }) as KeyboardEvent

test('find shortcuts use Meta on macOS and Ctrl on Windows', () => {
  assert.equal(isOpenFindBarShortcut(event({ metaKey: true }), 'darwin'), true)
  assert.equal(isOpenFindBarShortcut(event({ ctrlKey: true }), 'win32'), true)
  assert.equal(
    isOpenSidebarSearchShortcut(event({ metaKey: true, shiftKey: true }), 'darwin'),
    true
  )
  assert.equal(isOpenSidebarSearchShortcut(event({ ctrlKey: true, shiftKey: true }), 'win32'), true)
})

test('find shortcuts reject Ctrl+Meta, Alt, and the wrong Shift state', () => {
  assert.equal(isOpenFindBarShortcut(event({ ctrlKey: true, metaKey: true }), 'win32'), false)
  assert.equal(isOpenFindBarShortcut(event({ altKey: true, ctrlKey: true }), 'win32'), false)
  assert.equal(isOpenFindBarShortcut(event({ ctrlKey: true, shiftKey: true }), 'win32'), false)
  assert.equal(isOpenSidebarSearchShortcut(event({ ctrlKey: true }), 'win32'), false)
})
