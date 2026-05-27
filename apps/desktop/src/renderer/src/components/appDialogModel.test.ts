import assert from 'node:assert/strict'
import test from 'node:test'

import { getDefaultDialogActionKey, shouldSubmitDialogAction } from './appDialogModel.ts'

test('getDefaultDialogActionKey uses the explicit autofocus action first', () => {
  assert.equal(
    getDefaultDialogActionKey([
      { key: 'delete', tone: 'danger' },
      { key: 'cancel', autoFocus: true }
    ]),
    'cancel'
  )
})

test('getDefaultDialogActionKey skips disabled actions', () => {
  assert.equal(
    getDefaultDialogActionKey([
      { key: 'delete', tone: 'danger', autoFocus: true, disabled: true },
      { key: 'open', tone: 'accent' },
      { key: 'cancel' }
    ]),
    'open'
  )
})

test('getDefaultDialogActionKey returns null when no action can run', () => {
  assert.equal(
    getDefaultDialogActionKey([
      { key: 'delete', tone: 'danger', disabled: true },
      { key: 'cancel', disabled: true }
    ]),
    null
  )
})

test('shouldSubmitDialogAction accepts plain Enter', () => {
  assert.equal(shouldSubmitDialogAction({ key: 'Enter' }), true)
})

test('shouldSubmitDialogAction lets focused native controls handle Enter', () => {
  assert.equal(shouldSubmitDialogAction({ key: 'Enter' }, { tagName: 'button' }), false)
  assert.equal(shouldSubmitDialogAction({ key: 'Enter' }, { tagName: 'a' }), false)
  assert.equal(shouldSubmitDialogAction({ key: 'Enter' }, { tagName: 'select' }), false)
})

test('shouldSubmitDialogAction still submits from text inputs', () => {
  assert.equal(shouldSubmitDialogAction({ key: 'Enter' }, { tagName: 'input', type: 'text' }), true)
})

test('shouldSubmitDialogAction ignores modified Enter and multiline text targets', () => {
  assert.equal(shouldSubmitDialogAction({ key: 'Enter', metaKey: true }), false)
  assert.equal(shouldSubmitDialogAction({ key: 'Enter' }, { tagName: 'textarea' }), false)
  assert.equal(shouldSubmitDialogAction({ key: 'Enter' }, { isContentEditable: true }), false)
})

test('shouldSubmitDialogAction ignores IME composition Enter events', () => {
  assert.equal(shouldSubmitDialogAction({ key: 'Enter', isComposing: true }), false)
  assert.equal(shouldSubmitDialogAction({ key: 'Enter', keyCode: 229 }), false)
})
