import assert from 'node:assert/strict'
import test from 'node:test'

import type { ModelUsage } from '../../../../runtime/models/types.ts'
import { accumulateRunLoopUsage, mergeUsageForTerminal } from './runUsage.ts'
import { mergeRunUsage } from '../execution/runUsage.ts'
import { usageFieldsFrom } from '../runUsageFields.ts'

function makeUsage(modelGenerationDurationMs: number, timeToFirstTokenMs?: number): ModelUsage {
  return {
    promptTokens: 100,
    completionTokens: 20,
    totalPromptTokens: 100,
    totalCompletionTokens: 20,
    modelGenerationDurationMs,
    ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {})
  }
}

test('last call output survives steer accumulation and terminal persistence without summing', () => {
  const first = { ...makeUsage(750), lastCompletionTokens: 20 }
  const last = { ...makeUsage(1250), completionTokens: 30, lastCompletionTokens: 30 }
  const prior = accumulateRunLoopUsage(undefined, first)
  assert.equal(prior?.lastCompletionTokens, 20)
  for (const merged of [
    accumulateRunLoopUsage(prior, last),
    mergeUsageForTerminal(prior, last),
    mergeRunUsage(prior, last)
  ]) {
    assert.equal(merged?.completionTokens, 50)
    assert.equal(usageFieldsFrom(merged).lastCompletionTokens, 30)
  }
  assert.equal(mergeRunUsage(prior, undefined)?.lastCompletionTokens, 20)
})

test('run-loop usage keeps model generation time across steer legs', () => {
  const accumulated = accumulateRunLoopUsage(undefined, makeUsage(750))
  const next = accumulateRunLoopUsage(accumulated, makeUsage(1_250))

  assert.equal(next?.modelGenerationDurationMs, 2_000)
  assert.equal(
    mergeUsageForTerminal(accumulated, makeUsage(1_250))?.modelGenerationDurationMs,
    2_000
  )
})
test('run-loop usage keeps the first token time from the earliest steer leg', () => {
  const accumulated = accumulateRunLoopUsage(undefined, makeUsage(750, 420))
  const merged = mergeUsageForTerminal(accumulated, makeUsage(1_250, 180))

  assert.equal(merged?.timeToFirstTokenMs, 420)
})
