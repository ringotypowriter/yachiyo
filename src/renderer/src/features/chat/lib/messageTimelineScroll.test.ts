import assert from 'node:assert/strict'
import test from 'node:test'

import { getInitialBottomScrollDecision } from './messageTimelineScroll.ts'

test('getInitialBottomScrollDecision retries when the first startup scroll lands above the bottom', () => {
  assert.equal(
    getInitialBottomScrollDecision({
      attempt: 0,
      maxAttempts: 3,
      metrics: {
        scrollHeight: 1600,
        clientHeight: 600,
        scrollTop: 0
      }
    }),
    'retry'
  )
})

test('getInitialBottomScrollDecision settles when the timeline is already at the bottom', () => {
  assert.equal(
    getInitialBottomScrollDecision({
      attempt: 0,
      maxAttempts: 3,
      metrics: {
        scrollHeight: 1600,
        clientHeight: 600,
        scrollTop: 997
      }
    }),
    'done'
  )
})

test('getInitialBottomScrollDecision treats short timelines as settled', () => {
  assert.equal(
    getInitialBottomScrollDecision({
      attempt: 0,
      maxAttempts: 3,
      metrics: {
        scrollHeight: 300,
        clientHeight: 600,
        scrollTop: 0
      }
    }),
    'done'
  )
})

test('getInitialBottomScrollDecision retries while the viewport has no layout size', () => {
  assert.equal(
    getInitialBottomScrollDecision({
      attempt: 0,
      maxAttempts: 3,
      metrics: {
        scrollHeight: 0,
        clientHeight: 0,
        scrollTop: 0
      }
    }),
    'retry'
  )
})

test('getInitialBottomScrollDecision stops after the retry budget is exhausted', () => {
  assert.equal(
    getInitialBottomScrollDecision({
      attempt: 3,
      maxAttempts: 3,
      metrics: {
        scrollHeight: 1600,
        clientHeight: 600,
        scrollTop: 0
      }
    }),
    'done'
  )
})
