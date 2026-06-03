import assert from 'node:assert/strict'
import test from 'node:test'

import {
  prependPromptDraftRow,
  promptRowsFromStoredPrompts,
  promptRowsToStoredOrder,
  shiftPromptKeycodeErrorsForPrependedRow
} from './promptsPaneModel.ts'

test('prompt rows display newest stored prompt first', () => {
  const rows = promptRowsFromStoredPrompts([
    { keycode: 'oldest', text: 'Oldest prompt' },
    { keycode: 'newest', text: 'Newest prompt' }
  ])

  assert.deepEqual(rows, [
    { keycode: 'newest', text: 'Newest prompt' },
    { keycode: 'oldest', text: 'Oldest prompt' }
  ])
  assert.deepEqual(promptRowsToStoredOrder(rows), [
    { keycode: 'oldest', text: 'Oldest prompt' },
    { keycode: 'newest', text: 'Newest prompt' }
  ])
})

test('prepends a new prompt row and shifts keycode errors with existing rows', () => {
  assert.deepEqual(prependPromptDraftRow([{ keycode: 'fix', text: 'Please fix:' }]), [
    { keycode: '', text: '' },
    { keycode: 'fix', text: 'Please fix:' }
  ])

  assert.deepEqual(shiftPromptKeycodeErrorsForPrependedRow({ 0: 'Keycode already used.' }), {
    1: 'Keycode already used.'
  })
})
