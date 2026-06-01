import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldSubmitAskUserAnswer } from './askUserEnterBehavior.ts'

test('does not submit askUser answers while IME composition is active', () => {
  assert.equal(
    shouldSubmitAskUserAnswer({
      key: 'Enter',
      shiftKey: false,
      isComposing: true,
      keyCode: 13
    }),
    false
  )
})

test('does not submit askUser answers for the IME processing Enter event', () => {
  assert.equal(
    shouldSubmitAskUserAnswer({
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      keyCode: 229
    }),
    false
  )
})

test('submits askUser answers only on plain Enter', () => {
  assert.equal(
    shouldSubmitAskUserAnswer({
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      keyCode: 13
    }),
    true
  )

  assert.equal(
    shouldSubmitAskUserAnswer({
      key: 'Enter',
      shiftKey: true,
      isComposing: false,
      keyCode: 13
    }),
    false
  )

  assert.equal(
    shouldSubmitAskUserAnswer({
      key: 'Escape',
      shiftKey: false,
      isComposing: false,
      keyCode: 27
    }),
    false
  )
})
