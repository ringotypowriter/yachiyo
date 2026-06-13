import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveContextHandoffThreshold,
  shouldTriggerContextHandoffForActualPromptTokens
} from './contextHandoffPolicy.ts'

test('resolveContextHandoffThreshold uses the configured boundary without a safety discount', () => {
  assert.equal(
    resolveContextHandoffThreshold({ chat: { stripCompactThresholdTokens: 128_000 } }),
    128_000
  )
})

test('shouldTriggerContextHandoffForActualPromptTokens requires actual prompt tokens at the threshold', () => {
  assert.equal(
    shouldTriggerContextHandoffForActualPromptTokens({
      actualPromptTokens: undefined,
      thresholdTokens: 128_000
    }),
    false
  )
  assert.equal(
    shouldTriggerContextHandoffForActualPromptTokens({
      actualPromptTokens: 110_000,
      thresholdTokens: 128_000
    }),
    false
  )
  assert.equal(
    shouldTriggerContextHandoffForActualPromptTokens({
      actualPromptTokens: 128_000,
      thresholdTokens: 128_000
    }),
    true
  )
})
