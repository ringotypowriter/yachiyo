import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePredictionKey } from './composerPrediction.ts'

const event = {
  key: 'Tab',
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 9
}
test('Tab and right arrow accept only an empty input', () => {
  assert.equal(resolvePredictionKey(event, 0, 0, 0), 'accept')
  assert.equal(resolvePredictionKey({ ...event, key: 'ArrowRight' }, 0, 0, 0), 'accept')
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
    assert.equal(resolvePredictionKey({ ...event, ...override }, 0, 0, 0), null)
  }
  assert.equal(resolvePredictionKey({ ...event, key: 'Escape' }, 0, 0, 0), 'dismiss')
  assert.equal(resolvePredictionKey({ ...event, key: 'Escape', isComposing: true }, 0, 0, 0), null)
})
test('nonempty input is never treated as a continuation target', () => {
  assert.equal(resolvePredictionKey(event, 4, 4, 4), null)
  assert.equal(resolvePredictionKey({ ...event, key: 'ArrowRight' }, 4, 4, 4), null)
})
