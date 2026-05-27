import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunRecord } from '@renderer/app/types'
import { selectContextPromptTokens } from './contextPromptTokens.ts'

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 'run',
    threadId: 'thread',
    status: 'completed',
    createdAt: '2026-03-15T00:00:00.000Z',
    ...overrides
  }
}

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
