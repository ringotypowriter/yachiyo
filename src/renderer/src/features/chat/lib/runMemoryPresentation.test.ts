import assert from 'node:assert/strict'
import test from 'node:test'

import { findRunMemorySummary } from './runMemoryPresentation.ts'

test('findRunMemorySummary returns the latest recalled memory for a request', () => {
  const summary = findRunMemorySummary(
    [
      {
        id: 'run-1',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-22T00:00:00.000Z',
        requestMessageId: 'user-1',
        recalledMemoryEntries: ['older']
      },
      {
        id: 'run-2',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-22T00:00:01.000Z',
        requestMessageId: 'user-1',
        recalledMemoryEntries: ['newer'],
        recallDecision: {
          shouldRecall: true,
          score: 0.6,
          reasons: ['char-growth'],
          messagesSinceLastRecall: 3,
          charsSinceLastRecall: 1200,
          idleMs: 0,
          noveltyScore: 0.2,
          novelTerms: []
        }
      }
    ],
    'user-1'
  )

  assert.deepEqual(summary, {
    runId: 'run-2',
    entries: ['newer'],
    recallDecision: {
      shouldRecall: true,
      score: 0.6,
      reasons: ['char-growth'],
      messagesSinceLastRecall: 3,
      charsSinceLastRecall: 1200,
      idleMs: 0,
      noveltyScore: 0.2,
      novelTerms: []
    }
  })
})

test('findRunMemorySummary returns null when the matched run recalled nothing useful', () => {
  const summary = findRunMemorySummary(
    [
      {
        id: 'run-1',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-22T00:00:00.000Z',
        requestMessageId: 'user-1',
        recalledMemoryEntries: ['   ']
      }
    ],
    'user-1'
  )

  assert.equal(summary, null)
})
