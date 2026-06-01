import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolCall } from '@renderer/app/types'

import {
  compactNovelTermsForDisplay,
  countToolCallsForRun,
  findLatestRunForRequest,
  findLatestRunForRequests,
  findRunMemorySummary,
  findRunMemorySummaryForRequests
} from './runMemoryPresentation.ts'

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
          score: 0.8,
          reasons: ['topic-novelty'],
          messagesSinceLastRecall: 3,
          charsSinceLastRecall: 1200,
          idleMs: 0,
          noveltyScore: 0.8,
          novelTerms: ['deployment']
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
      score: 0.8,
      reasons: ['topic-novelty'],
      messagesSinceLastRecall: 3,
      charsSinceLastRecall: 1200,
      idleMs: 0,
      noveltyScore: 0.8,
      novelTerms: ['deployment']
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

test('findLatestRunForRequest prefers the newest matching retry for a request', () => {
  const run = findLatestRunForRequest(
    [
      {
        id: 'run-older',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-22T00:00:00.000Z',
        completedAt: '2026-03-22T00:00:03.000Z',
        requestMessageId: 'user-1',
        snapshotFileCount: 0
      },
      {
        id: 'run-newer',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-22T00:00:05.000Z',
        completedAt: '2026-03-22T00:00:08.000Z',
        requestMessageId: 'user-1',
        snapshotFileCount: 4,
        workspacePath: '/tmp/external-workspace'
      },
      {
        id: 'run-other-request',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-22T00:00:10.000Z',
        completedAt: '2026-03-22T00:00:11.000Z',
        requestMessageId: 'user-2',
        snapshotFileCount: 99
      }
    ],
    'user-1'
  )

  assert.deepEqual(run, {
    id: 'run-newer',
    threadId: 'thread-1',
    status: 'completed',
    createdAt: '2026-03-22T00:00:05.000Z',
    completedAt: '2026-03-22T00:00:08.000Z',
    requestMessageId: 'user-1',
    snapshotFileCount: 4,
    workspacePath: '/tmp/external-workspace'
  })
})

test('findLatestRunForRequests prefers the newest run across merged request anchors', () => {
  const run = findLatestRunForRequests(
    [
      {
        id: 'run-visible',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-22T00:00:00.000Z',
        requestMessageId: 'user-1'
      },
      {
        id: 'run-hidden',
        threadId: 'thread-1',
        status: 'failed',
        error: 'hidden failed',
        createdAt: '2026-03-22T00:00:05.000Z',
        requestMessageId: 'hidden-background-notice'
      },
      {
        id: 'run-other',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-22T00:00:10.000Z',
        requestMessageId: 'user-2'
      }
    ],
    ['user-1', 'hidden-background-notice']
  )

  assert.equal(run?.id, 'run-hidden')
})

test('findRunMemorySummaryForRequests reads memory from merged hidden request anchors', () => {
  const summary = findRunMemorySummaryForRequests(
    [
      {
        id: 'run-hidden',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-22T00:00:05.000Z',
        requestMessageId: 'hidden-background-notice',
        recalledMemoryEntries: ['background context']
      }
    ],
    ['user-1', 'hidden-background-notice']
  )

  assert.deepEqual(summary, {
    runId: 'run-hidden',
    entries: ['background context'],
    recallDecision: undefined
  })
})

test('compactNovelTermsForDisplay hides low-signal mixed-language fragments', () => {
  const terms = compactNovelTermsForDisplay([
    'my',
    'alpha beta gamma',
    'cache 模型',
    'vector index',
    'tool timeout',
    'agent scheduling'
  ])

  assert.deepEqual(terms, ['vector index', 'tool timeout', 'agent scheduling'])
})

test('compactNovelTermsForDisplay keeps strong single technical terms and removes duplicates', () => {
  const terms = compactNovelTermsForDisplay([
    ' deploy ',
    'deploy',
    'system prompt',
    'deploy workflow',
    'your'
  ])

  assert.deepEqual(terms, ['deploy', 'system prompt', 'deploy workflow'])
})

test('countToolCallsForRun includes post-steer tool calls re-anchored to a new requestMessageId', () => {
  const toolCalls: ToolCall[] = [
    {
      id: 'tc-1',
      runId: 'run-1',
      threadId: 'thread-1',
      requestMessageId: 'user-1',
      toolName: 'bash',
      status: 'completed',
      inputSummary: '',
      startedAt: '2026-03-22T00:00:00.000Z'
    },
    {
      id: 'tc-2',
      runId: 'run-1',
      threadId: 'thread-1',
      requestMessageId: 'user-1',
      toolName: 'bash',
      status: 'completed',
      inputSummary: '',
      startedAt: '2026-03-22T00:00:01.000Z'
    },
    // Post-steer: same run, but requestMessageId is the steer user message.
    {
      id: 'tc-3',
      runId: 'run-1',
      threadId: 'thread-1',
      requestMessageId: 'user-steer',
      toolName: 'bash',
      status: 'completed',
      inputSummary: '',
      startedAt: '2026-03-22T00:00:02.000Z'
    },
    // Unrelated run must be excluded.
    {
      id: 'tc-4',
      runId: 'run-2',
      threadId: 'thread-1',
      requestMessageId: 'user-2',
      toolName: 'bash',
      status: 'completed',
      inputSummary: '',
      startedAt: '2026-03-22T00:00:03.000Z'
    }
  ]

  assert.equal(countToolCallsForRun(toolCalls, 'run-1'), 3)
  assert.equal(countToolCallsForRun(toolCalls, 'run-2'), 1)
  assert.equal(countToolCallsForRun(toolCalls, 'run-missing'), 0)
})
