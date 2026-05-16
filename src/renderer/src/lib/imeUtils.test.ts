import assert from 'node:assert/strict'
import test from 'node:test'

import { isDismissEscapeKey } from './imeUtils.ts'

function keyEvent(input: {
  key: string
  isComposing?: boolean
  keyCode?: number
}): Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode'> {
  return {
    key: input.key,
    isComposing: input.isComposing ?? false,
    keyCode: input.keyCode ?? 0
  }
}

test('isDismissEscapeKey accepts a plain Escape key press', () => {
  assert.equal(isDismissEscapeKey(keyEvent({ key: 'Escape' })), true)
})

test('isDismissEscapeKey ignores non-Escape keys', () => {
  assert.equal(isDismissEscapeKey(keyEvent({ key: 'Enter' })), false)
})

test('isDismissEscapeKey ignores Escape while IME composition is active', () => {
  assert.equal(isDismissEscapeKey(keyEvent({ key: 'Escape', isComposing: true })), false)
})

test('isDismissEscapeKey ignores IME processing sentinel events', () => {
  assert.equal(isDismissEscapeKey(keyEvent({ key: 'Escape', keyCode: 229 })), false)
})
