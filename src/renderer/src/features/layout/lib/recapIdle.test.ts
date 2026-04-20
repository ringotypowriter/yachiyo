import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RECAP_IDLE_LABEL,
  RECAP_IDLE_THRESHOLD_MS,
  RECAP_MESSAGE_THRESHOLD,
  RECAP_TOKEN_THRESHOLD,
  hasRecapIdleThresholdElapsed,
  computeRecapDecision
} from './recapIdle.ts'
import type { RecapEligibilityInput } from './recapIdle.ts'

const NOW = Date.UTC(2026, 3, 20, 12, 0, 0)

function baseInput(overrides: Partial<RecapEligibilityInput> = {}): RecapEligibilityInput {
  return {
    recapEnabled: true,
    isExternalThread: false,
    isAcpThread: false,
    hasActiveRun: false,
    isEditingMessage: false,
    messageCount: 10,
    lastPromptTokens: 0,
    hasExistingRecap: false,
    updatedAtMs: NOW - RECAP_IDLE_THRESHOLD_MS - 1000,
    nowMs: NOW,
    ...overrides
  }
}

// --- hasRecapIdleThresholdElapsed (existing) ---

test('uses a slightly early idle threshold while keeping the rounded user-facing label', () => {
  assert.equal(RECAP_IDLE_LABEL, '5 minutes')
  assert.equal(RECAP_IDLE_THRESHOLD_MS, 4 * 60 * 1000 + 55 * 1000)
})

test('treats threads as idle once the 4:55 threshold has elapsed', () => {
  assert.equal(hasRecapIdleThresholdElapsed(NOW - (4 * 60 * 1000 + 54 * 1000), NOW), false)
  assert.equal(hasRecapIdleThresholdElapsed(NOW - (4 * 60 * 1000 + 55 * 1000), NOW), true)
})

// --- computeRecapDecision ---

test('fires immediately when idle threshold has elapsed and message count > 5', () => {
  const decision = computeRecapDecision(baseInput())
  assert.deepEqual(decision, { action: 'fire' })
})

test('schedules timer when idle threshold has not yet elapsed', () => {
  const threeMinAgo = NOW - 3 * 60 * 1000
  const decision = computeRecapDecision(baseInput({ updatedAtMs: threeMinAgo }))
  assert.equal(decision.action, 'schedule')
  assert.equal((decision as { delayMs: number }).delayMs, RECAP_IDLE_THRESHOLD_MS - 3 * 60 * 1000)
})

test('schedules correct remaining delay for a thread updated 3 minutes ago', () => {
  const threeMinAgo = NOW - 3 * 60 * 1000
  const decision = computeRecapDecision(baseInput({ updatedAtMs: threeMinAgo }))
  assert.equal(decision.action, 'schedule')
  const expected = RECAP_IDLE_THRESHOLD_MS - 3 * 60 * 1000
  assert.equal((decision as { delayMs: number }).delayMs, expected)
  assert.ok(expected > 0 && expected < 2 * 60 * 1000)
})

// --- skip conditions ---

test('skips when recap is disabled', () => {
  const decision = computeRecapDecision(baseInput({ recapEnabled: false }))
  assert.deepEqual(decision, { action: 'skip' })
})

test('skips for external threads', () => {
  const decision = computeRecapDecision(baseInput({ isExternalThread: true }))
  assert.deepEqual(decision, { action: 'skip' })
})

test('skips for acp threads', () => {
  const decision = computeRecapDecision(baseInput({ isAcpThread: true }))
  assert.deepEqual(decision, { action: 'skip' })
})

test('skips when a run is active', () => {
  const decision = computeRecapDecision(baseInput({ hasActiveRun: true }))
  assert.deepEqual(decision, { action: 'skip' })
})

test('skips when user is editing a message', () => {
  const decision = computeRecapDecision(baseInput({ isEditingMessage: true }))
  assert.deepEqual(decision, { action: 'skip' })
})

test('skips when recap already exists', () => {
  const decision = computeRecapDecision(baseInput({ hasExistingRecap: true }))
  assert.deepEqual(decision, { action: 'skip' })
})

// --- message count / token threshold ---

test('skips when message count <= 5 and tokens <= 32k', () => {
  const decision = computeRecapDecision(
    baseInput({
      messageCount: 3,
      lastPromptTokens: 10_000
    })
  )
  assert.deepEqual(decision, { action: 'skip' })
})

test('fires when message count <= 5 but tokens > 32k', () => {
  const decision = computeRecapDecision(
    baseInput({
      messageCount: 3,
      lastPromptTokens: 50_000
    })
  )
  assert.deepEqual(decision, { action: 'fire' })
})

test('fires when message count > 5 but tokens <= 32k', () => {
  const decision = computeRecapDecision(
    baseInput({
      messageCount: 10,
      lastPromptTokens: 1_000
    })
  )
  assert.deepEqual(decision, { action: 'fire' })
})

test('skips at exact threshold boundaries (messageCount=5, tokens=32000)', () => {
  const decision = computeRecapDecision(
    baseInput({
      messageCount: RECAP_MESSAGE_THRESHOLD,
      lastPromptTokens: RECAP_TOKEN_THRESHOLD
    })
  )
  assert.deepEqual(decision, { action: 'skip' })
})

test('fires when messageCount is 6 (just above threshold) with zero tokens', () => {
  const decision = computeRecapDecision(
    baseInput({
      messageCount: RECAP_MESSAGE_THRESHOLD + 1,
      lastPromptTokens: 0
    })
  )
  assert.deepEqual(decision, { action: 'fire' })
})

test('fires when tokens are 32001 (just above threshold) with few messages', () => {
  const decision = computeRecapDecision(
    baseInput({
      messageCount: 2,
      lastPromptTokens: RECAP_TOKEN_THRESHOLD + 1
    })
  )
  assert.deepEqual(decision, { action: 'fire' })
})

// --- timer reset scenarios ---

test('run ending re-evaluates: active run skips, inactive run schedules', () => {
  const recent = NOW - 60_000
  assert.deepEqual(computeRecapDecision(baseInput({ hasActiveRun: true, updatedAtMs: recent })), {
    action: 'skip'
  })
  const afterRun = computeRecapDecision(baseInput({ hasActiveRun: false, updatedAtMs: recent }))
  assert.equal(afterRun.action, 'schedule')
})

test('editing message resets: editing skips, stopping edit re-evaluates', () => {
  assert.deepEqual(computeRecapDecision(baseInput({ isEditingMessage: true })), { action: 'skip' })
  assert.deepEqual(computeRecapDecision(baseInput({ isEditingMessage: false })), { action: 'fire' })
})

test('message count change resets timer: schedules fresh delay from updatedAt', () => {
  const twoMinAgo = NOW - 2 * 60 * 1000
  const d1 = computeRecapDecision(baseInput({ messageCount: 8, updatedAtMs: twoMinAgo }))
  assert.equal(d1.action, 'schedule')

  const d2 = computeRecapDecision(baseInput({ messageCount: 9, updatedAtMs: NOW }))
  assert.equal(d2.action, 'schedule')
  assert.equal((d2 as { delayMs: number }).delayMs, RECAP_IDLE_THRESHOLD_MS)
})
