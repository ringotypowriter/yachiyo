import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldHandleWorkShortcut } from './workShortcutScope.ts'

test('work shortcuts stay enabled in Chat and Archived tabs', () => {
  assert.equal(shouldHandleWorkShortcut('chat'), true)
  assert.equal(shouldHandleWorkShortcut('archived'), true)
})

test('work shortcuts are disabled while Settings is active', () => {
  assert.equal(shouldHandleWorkShortcut('settings'), false)
})

test('work shortcuts are disabled while Things shows passive Work sidebar context', () => {
  assert.equal(shouldHandleWorkShortcut('things'), false)
})
