import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RECAP_IDLE_LABEL,
  RECAP_IDLE_THRESHOLD_MS,
  hasRecapIdleThresholdElapsed
} from './recapIdle.ts'

test('uses a slightly early idle threshold while keeping the rounded user-facing label', () => {
  assert.equal(RECAP_IDLE_LABEL, '5 minutes')
  assert.equal(RECAP_IDLE_THRESHOLD_MS, 4 * 60 * 1000 + 55 * 1000)
})

test('treats threads as idle once the 4:55 threshold has elapsed', () => {
  const now = Date.UTC(2026, 3, 20, 12, 0, 0)

  assert.equal(hasRecapIdleThresholdElapsed(now - (4 * 60 * 1000 + 54 * 1000), now), false)
  assert.equal(hasRecapIdleThresholdElapsed(now - (4 * 60 * 1000 + 55 * 1000), now), true)
})
