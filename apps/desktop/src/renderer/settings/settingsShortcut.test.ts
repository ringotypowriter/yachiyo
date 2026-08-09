import assert from 'node:assert/strict'
import test from 'node:test'

import { isSaveSettingsShortcut } from './settingsShortcut.ts'

test('save settings uses the platform primary modifier and rejects ambiguous combinations', () => {
  const base = { altKey: false, ctrlKey: false, key: 's', metaKey: false, shiftKey: false }

  assert.equal(isSaveSettingsShortcut({ ...base, metaKey: true }, 'darwin'), true)
  assert.equal(isSaveSettingsShortcut({ ...base, ctrlKey: true }, 'win32'), true)
  assert.equal(isSaveSettingsShortcut({ ...base, ctrlKey: true, metaKey: true }, 'win32'), false)
  assert.equal(isSaveSettingsShortcut({ ...base, altKey: true, ctrlKey: true }, 'win32'), false)
  assert.equal(isSaveSettingsShortcut({ ...base, ctrlKey: true, shiftKey: true }, 'win32'), false)
})
