import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeRunUsage } from './runExecution.ts'
import type { ModelUsage } from '../../runtime/types.ts'

function makeUsage(promptTokens: number, completionTokens: number): ModelUsage {
  return {
    promptTokens,
    completionTokens,
    totalPromptTokens: promptTokens,
    totalCompletionTokens: completionTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }
}

test('mergeRunUsage keeps promptTokens as the current leg size', () => {
  const result = mergeRunUsage(makeUsage(180_000, 1_000), makeUsage(50_000, 2_000))

  assert.deepEqual(result, {
    promptTokens: 50_000,
    completionTokens: 3_000,
    totalPromptTokens: 230_000,
    totalCompletionTokens: 3_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  })
})
