import assert from 'node:assert/strict'
import test from 'node:test'
import { predictionRemainder, resolvePredictionKey } from './composerPrediction.ts'

const event = {
  key: 'Tab',
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 9
}
test('Tab and right arrow accept only at an unselected end caret', () => {
  assert.equal(resolvePredictionKey(event, 4, 4, 4), 'accept')
  assert.equal(resolvePredictionKey({ ...event, key: 'ArrowRight' }, 4, 4, 4), 'accept')
  assert.equal(resolvePredictionKey(event, 3, 4, 4), null)
  assert.equal(resolvePredictionKey(event, 3, 3, 4), null)
  assert.equal(resolvePredictionKey({ ...event, key: 'Enter' }, 4, 4, 4), null)
})
test('native modifier and IME behavior is preserved', () => {
  for (const override of [
    { shiftKey: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 }
  ]) {
    assert.equal(resolvePredictionKey({ ...event, ...override }, 4, 4, 4), null)
  }
  assert.equal(resolvePredictionKey({ ...event, key: 'Escape' }, 4, 4, 4), 'dismiss')
  assert.equal(resolvePredictionKey({ ...event, key: 'Escape', isComposing: true }, 4, 4, 4), null)
})
test('matching typing consumes the suggestion, divergent drafts discard it', () => {
  assert.equal(predictionRemainder('write', ' a test', 'write a'), ' test')
  assert.equal(predictionRemainder('write', ' a test', 'write a test'), '')
  assert.equal(predictionRemainder('write', ' a test', 'write code'), '')
  assert.equal(predictionRemainder('write', ' a test', 'writ'), '')
})
