import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldSendOnComposerEnter } from './composerEnterBehavior.ts'

test('returns false while IME composition is active', () => {
  assert.equal(
    shouldSendOnComposerEnter({
      key: 'Enter',
      shiftKey: false,
      isComposing: true,
      keyCode: 13
    }),
    false
  )
})

test('returns false for the IME processing key event reported as keyCode 229', () => {
  assert.equal(
    shouldSendOnComposerEnter({
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      keyCode: 229
    }),
    false
  )
})

test('returns false when Enter should insert a newline or another key is pressed', () => {
  assert.equal(
    shouldSendOnComposerEnter({
      key: 'Enter',
      shiftKey: true,
      isComposing: false,
      keyCode: 13
    }),
    false
  )

  assert.equal(
    shouldSendOnComposerEnter({
      key: 'Escape',
      shiftKey: false,
      isComposing: false,
      keyCode: 27
    }),
    false
  )
})

test('returns true for a plain Enter press when composition is not active', () => {
  assert.equal(
    shouldSendOnComposerEnter({
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      keyCode: 13
    }),
    true
  )
})
