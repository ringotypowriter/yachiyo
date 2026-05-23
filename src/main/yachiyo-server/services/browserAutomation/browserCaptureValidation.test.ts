import assert from 'node:assert/strict'
import test from 'node:test'

import { assertNonEmptyScreenshotByteLength } from './browserCaptureValidation.ts'

test('assertNonEmptyScreenshotByteLength rejects empty screenshot captures', () => {
  assert.throws(() => assertNonEmptyScreenshotByteLength(0), /empty screenshot/i)
})

test('assertNonEmptyScreenshotByteLength accepts non-empty screenshot captures', () => {
  assert.doesNotThrow(() => assertNonEmptyScreenshotByteLength(1))
})
