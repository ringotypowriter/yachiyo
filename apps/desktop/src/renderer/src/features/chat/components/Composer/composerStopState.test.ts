import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isComposerCancelInFlightForThread,
  resolveComposerStopTarget,
  settleComposerCancelOperation,
  type ComposerCancelOperation
} from './composerStopState.ts'

function operation(
  operationId: number,
  threadId: string,
  promise: Promise<void> = Promise.resolve()
): ComposerCancelOperation {
  return { operationId, threadId, promise }
}

test('resolveComposerStopTarget cancels the parent before running Workers', () => {
  assert.equal(
    resolveComposerStopTarget({ hasActiveRun: true, threadId: 'thread-a', runningWorkerCount: 2 }),
    'parent'
  )
  assert.equal(
    resolveComposerStopTarget({ hasActiveRun: false, threadId: 'thread-a', runningWorkerCount: 2 }),
    'workers'
  )
})

test('resolveComposerStopTarget does not start work without a thread or active operation', () => {
  assert.equal(
    resolveComposerStopTarget({ hasActiveRun: false, threadId: null, runningWorkerCount: 2 }),
    'none'
  )
  assert.equal(
    resolveComposerStopTarget({ hasActiveRun: false, threadId: 'thread-a', runningWorkerCount: 0 }),
    'none'
  )
})

test('cancel-in-flight state is scoped to its originating thread', () => {
  const current = operation(4, 'thread-a')

  assert.equal(isComposerCancelInFlightForThread(current, 'thread-a'), true)
  assert.equal(isComposerCancelInFlightForThread(current, 'thread-b'), false)
  assert.equal(isComposerCancelInFlightForThread(current, null), false)
})

test('settling a rejected cancellation clears only the matching operation', () => {
  const current = operation(4, 'thread-a')
  const replacement = operation(5, 'thread-b')

  assert.equal(settleComposerCancelOperation(current, 4), null)
  assert.equal(settleComposerCancelOperation(replacement, 4), replacement)
})
