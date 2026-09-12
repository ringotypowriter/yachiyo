import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveRunAvatarPhase,
  selectRunAvatarPhase,
  shouldCelebrateRun
} from './runAvatarState.ts'
import { useAppStore } from '../../../app/store/useAppStore.ts'

const active = {
  active: true,
  receiving: false,
  hasText: false,
  hasReasoning: false,
  working: false,
  waiting: false
}

test('message completion does not flash loading before the run completion arrives', () => {
  const state = {
    ...useAppStore.getInitialState(),
    activeRunIdsByThread: { a: 'r' },
    activeRequestMessageIdsByThread: { a: 'request' },
    receivingModelOutputByThread: { a: true },
    pendingAssistantMessages: {},
    messages: {
      a: [
        {
          id: 'm',
          threadId: 'a',
          parentMessageId: 'request',
          role: 'assistant' as const,
          content: 'Done',
          status: 'completed' as const,
          createdAt: '2026-09-12T00:00:00Z'
        }
      ]
    }
  }
  assert.equal(selectRunAvatarPhase(state, 'a'), 'speaking')
  assert.equal(
    selectRunAvatarPhase({ ...state, activeRequestMessageIdsByThread: { a: 'other' } }, 'a'),
    'loading'
  )
  assert.equal(selectRunAvatarPhase({ ...state, activeRunIdsByThread: {} }, 'a'), 'idle')
})

test('composer and timeline share loading during retry even after receiving reasoning', () => {
  const state = {
    ...useAppStore.getInitialState(),
    activeRunIdsByThread: { a: 'r' },
    receivingModelOutputByThread: { a: true },
    pendingAssistantMessages: {
      r: { threadId: 'a', messageId: 'm', shouldStartNewTextBlock: true }
    },
    messages: {
      a: [
        {
          id: 'm',
          threadId: 'a',
          role: 'assistant' as const,
          content: '',
          reasoning: 'Old reasoning',
          status: 'streaming' as const,
          createdAt: '2026-09-12T00:00:00Z'
        }
      ]
    },
    retryInfoByThread: { a: { attempt: 1, maxAttempts: 3, error: 'Temporary failure' } }
  }
  assert.equal(selectRunAvatarPhase(state, 'a'), 'loading')
  assert.equal(selectRunAvatarPhase({ ...state, retryInfoByThread: {} }, 'a'), 'thinking')
})

test('tools from a previous run cannot override the active run', () => {
  const state = {
    ...useAppStore.getInitialState(),
    activeRunIdsByThread: { a: 'r' },
    toolCalls: {
      a: [
        {
          id: 't',
          runId: 'old',
          threadId: 'a',
          toolName: 'askUser',
          status: 'waiting-for-user' as const,
          inputSummary: 'Question',
          startedAt: '2026-09-12T00:00:00Z'
        }
      ]
    }
  }
  assert.equal(selectRunAvatarPhase(state, 'a'), 'loading')
  assert.equal(
    selectRunAvatarPhase({ ...state, activeRunIdsByThread: { a: 'old' } }, 'a'),
    'waiting'
  )
})

test('loading becomes thinking only with model output, and text output becomes speaking', () => {
  assert.equal(resolveRunAvatarPhase(active), 'loading')
  assert.equal(resolveRunAvatarPhase({ ...active, hasReasoning: true }), 'loading')
  assert.equal(
    resolveRunAvatarPhase({ ...active, receiving: true, hasReasoning: true }),
    'thinking'
  )
  assert.equal(resolveRunAvatarPhase({ ...active, receiving: true, hasText: true }), 'speaking')
})

test('waiting and tool work take priority over stale model output', () => {
  const output = { ...active, receiving: true, hasText: true, hasReasoning: true }
  assert.equal(resolveRunAvatarPhase({ ...output, working: true }), 'working')
  assert.equal(resolveRunAvatarPhase({ ...output, working: true, waiting: true }), 'waiting')
  assert.equal(resolveRunAvatarPhase({ ...output, active: false, working: true }), 'idle')
})

test('reasoning after a tool does not masquerade as the previous text response', () => {
  assert.equal(
    resolveRunAvatarPhase({
      ...active,
      receiving: true,
      hasText: true,
      hasReasoning: true,
      textPending: true
    }),
    'thinking'
  )
})

test('only a visible successful completion of the same run celebrates', () => {
  const previous = { threadId: 'a', runId: 'r' }
  assert.equal(
    shouldCelebrateRun(previous, {
      threadId: 'a',
      runId: null,
      completedRunId: 'r',
      status: 'completed'
    }),
    true
  )
  for (const status of ['failed', 'cancelled', 'idle']) {
    assert.equal(
      shouldCelebrateRun(previous, { threadId: 'a', runId: null, completedRunId: 'r', status }),
      false
    )
  }
  assert.equal(
    shouldCelebrateRun(previous, {
      threadId: 'b',
      runId: null,
      completedRunId: 'r',
      status: 'completed'
    }),
    false
  )
  assert.equal(
    shouldCelebrateRun(previous, {
      threadId: 'a',
      runId: 'next',
      completedRunId: 'r',
      status: 'completed'
    }),
    false
  )
  assert.equal(
    shouldCelebrateRun(
      { threadId: 'a', runId: null },
      { threadId: 'a', runId: null, completedRunId: 'r', status: 'completed' }
    ),
    false
  )
})
