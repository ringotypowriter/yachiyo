import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import { createRunOutputState, type RunOutputState } from './runOutputState.ts'

function buildCheckpoint(content: string): RunRecoveryCheckpoint {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    requestMessageId: 'req-1',
    assistantMessageId: 'msg-1',
    content,
    enabledTools: [],
    runTrigger: 'local',
    updateHeadOnComplete: true,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    recoveryAttempts: 0
  }
}

function createState(recoveryContent?: string): RunOutputState {
  let id = 0
  return createRunOutputState({
    deps: {
      createId: () => `id-${++id}`,
      timestamp: () => '2026-07-19T00:00:00.000Z'
    },
    ...(recoveryContent ? { recoveryCheckpoint: buildCheckpoint(recoveryContent) } : {}),
    toolCalls: []
  })
}

test('getContent stays correct across interleaved appends and repeated reads', () => {
  const state = createState()
  state.appendTextDelta('one ')
  state.appendTextDelta('two ')
  assert.equal(state.getContent(), 'one two ')
  assert.equal(state.getContent(), 'one two ')
  state.appendTextDelta('three')
  assert.equal(state.getContent(), 'one two three')
  assert.equal(state.getSnapshot().content, 'one two three')
})

test('snapshot reasoning stays correct across interleaved appends and snapshots', () => {
  const state = createState()
  state.appendReasoningDelta('think ')
  assert.equal(state.getSnapshot().reasoning, 'think ')
  state.appendReasoningDelta('harder')
  assert.equal(state.getSnapshot().reasoning, 'think harder')
  assert.equal(state.getSnapshot().reasoning, 'think harder')
})

test('recovered content is preserved and extended by new deltas', () => {
  const state = createState('recovered prefix ')
  assert.equal(state.getContent(), 'recovered prefix ')
  state.appendTextDelta('and the rest')
  assert.equal(state.getContent(), 'recovered prefix and the rest')
  assert.equal(state.getSnapshot().bufferLength, 'recovered prefix and the rest'.length)
})
