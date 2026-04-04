import assert from 'node:assert/strict'
import test from 'node:test'

import { isDevelopmentDemoModeEnabled } from './demoMode.ts'

test('demo mode is gated to development even when enabled in config', () => {
  assert.equal(isDevelopmentDemoModeEnabled({}, true), false)
  assert.equal(isDevelopmentDemoModeEnabled({ general: { demoMode: true } }, false), false)
  assert.equal(isDevelopmentDemoModeEnabled({ general: { demoMode: true } }, true), true)
})
