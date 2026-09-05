import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunRecord } from '@renderer/app/types'
import { selectContextPromptTokens, selectContextTokens } from './contextPromptTokens.ts'

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'run',
    threadId: 'thread',
    status: 'completed',
    createdAt: '2026-03-15T00:00:00.000Z',
    ...overrides
  }
}

test('context estimate adds only the last call output, not accumulated output', () => {
  const latestRun = run({
    promptTokens: 28_000,
    lastCompletionTokens: 3_000,
    completionTokens: 6_000,
    totalCompletionTokens: 6_000
  })
  assert.equal(selectContextTokens({ latestRun, runs: [] }), 31_000)
  assert.equal(selectContextPromptTokens({ latestRun, runs: [] }), 28_000)
})

test('legacy runs keep input-only estimates rather than adding ambiguous output totals', () => {
  assert.equal(
    selectContextTokens({
      latestRun: run({ promptTokens: 28_000, completionTokens: 6_000 }),
      runs: []
    }),
    28_000
  )
  assert.equal(
    selectContextTokens({ latestRun: run({ lastCompletionTokens: 3_000 }), runs: [] }),
    null
  )
})

test('cancelled run estimate uses input and output from the same previous run', () => {
  assert.equal(
    selectContextTokens({
      latestRun: run({
        id: 'cancelled',
        status: 'cancelled',
        promptTokens: 50_000,
        lastCompletionTokens: 9_000
      }),
      runs: [run({ id: 'previous', promptTokens: 28_000, lastCompletionTokens: 3_000 })]
    }),
    31_000
  )
})

test('selectContextPromptTokens uses the latest run tokens for non-cancelled runs', () => {
  assert.equal(
    selectContextPromptTokens({
      latestRun: run({ id: 'run-current', status: 'running', promptTokens: 30_000 }),
      runs: [run({ id: 'run-previous', promptTokens: 200_000 })]
    }),
    30_000
  )
})

test('selectContextPromptTokens reuses previous completed prompt tokens after cancellation', () => {
  assert.equal(
    selectContextPromptTokens({
      latestRun: run({
        id: 'run-cancelled',
        status: 'cancelled',
        createdAt: '2026-03-15T00:10:00.000Z',
        promptTokens: 30_000
      }),
      runs: [
        run({
          id: 'run-older',
          promptTokens: 120_000,
          completedAt: '2026-03-15T00:01:00.000Z'
        }),
        run({
          id: 'run-previous',
          promptTokens: 200_000,
          completedAt: '2026-03-15T00:05:00.000Z'
        }),
        run({
          id: 'run-cancelled',
          status: 'cancelled',
          promptTokens: 30_000,
          completedAt: '2026-03-15T00:10:00.000Z'
        })
      ]
    }),
    200_000
  )
})

test('selectContextPromptTokens returns null for cancelled runs without previous completed tokens', () => {
  assert.equal(
    selectContextPromptTokens({
      latestRun: run({ id: 'run-cancelled', status: 'cancelled', promptTokens: 30_000 }),
      runs: [run({ id: 'run-cancelled', status: 'cancelled', promptTokens: 30_000 })]
    }),
    null
  )
})
