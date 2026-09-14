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

test('idle avatar selection does not read message or tool history', () => {
  const state = {
    ...useAppStore.getInitialState(),
    get messages(): ReturnType<typeof useAppStore.getState>['messages'] {
      throw new Error('Idle avatars must not scan message history')
    },
    get toolCalls(): ReturnType<typeof useAppStore.getState>['toolCalls'] {
      throw new Error('Idle avatars must not scan tool history')
    }
  }
  assert.equal(selectRunAvatarPhase(state, 'a'), 'idle')
})

test('streaming avatar selection finds the current message from the end of history', () => {
  const message = {
    id: 'current',
    threadId: 'a',
    role: 'assistant' as const,
    content: 'Streaming',
    status: 'streaming' as const,
    createdAt: '2026-09-14T00:00:00Z'
  }
  const state = {
    ...useAppStore.getInitialState(),
    activeRunIdsByThread: { a: 'r' },
    receivingModelOutputByThread: { a: true },
    pendingAssistantMessages: {
      r: { threadId: 'a', messageId: 'current', shouldStartNewTextBlock: false }
    },
    messages: {
      a: [
        {
          ...message,
          get id(): string {
            throw new Error('Current output must be found before older messages are visited')
          }
        },
        message
      ]
    }
  }
  assert.equal(selectRunAvatarPhase(state, 'a'), 'speaking')
})

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
    'thinking'
  )
  assert.equal(selectRunAvatarPhase({ ...state, activeRunIdsByThread: {} }, 'a'), 'idle')
})

test('retry waiting stays thinking after a run has started responding', () => {
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
  assert.equal(selectRunAvatarPhase(state, 'a'), 'thinking')
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

test('only the initial network wait is loading; subsequent waits are thinking', () => {
  assert.equal(resolveRunAvatarPhase(active), 'loading')
  assert.equal(resolveRunAvatarPhase({ ...active, hasReasoning: true }), 'thinking')
  assert.equal(resolveRunAvatarPhase({ ...active, hasText: true }), 'thinking')
  assert.equal(resolveRunAvatarPhase({ ...active, receiving: true }), 'thinking')
  assert.equal(
    resolveRunAvatarPhase({ ...active, receiving: true, hasReasoning: true }),
    'thinking'
  )
  assert.equal(resolveRunAvatarPhase({ ...active, receiving: true, hasText: true }), 'speaking')
})

test('tool-only runs and continued requests enter thinking without any reasoning text', () => {
  const state = {
    ...useAppStore.getInitialState(),
    activeRunIdsByThread: { a: 'r' },
    runPhasesByThread: { a: 'preparing' as const }
  }
  assert.equal(selectRunAvatarPhase(state, 'a'), 'loading')
  assert.equal(
    selectRunAvatarPhase({ ...state, runPhasesByThread: { a: 'streaming' } }, 'a'),
    'thinking'
  )
  const tool = {
    id: 'tool',
    runId: 'r',
    threadId: 'a',
    toolName: 'read' as const,
    status: 'completed' as const,
    inputSummary: '',
    startedAt: '2026-09-13T00:00:00Z'
  }
  assert.equal(selectRunAvatarPhase({ ...state, toolCalls: { a: [tool] } }, 'a'), 'thinking')
  assert.equal(
    selectRunAvatarPhase(
      { ...state, toolCalls: { a: [tool] }, activeRunIdsByThread: { a: 'new' } },
      'a'
    ),
    'loading'
  )
  assert.equal(
    selectRunAvatarPhase(
      { ...state, retryInfoByThread: { a: { attempt: 1, maxAttempts: 3, error: 'retry' } } },
      'a'
    ),
    'thinking'
  )
})

test('a new run for an existing request starts loading instead of reusing its old answer', () => {
  assert.equal(
    selectRunAvatarPhase(
      {
        ...useAppStore.getInitialState(),
        activeRunIdsByThread: { a: 'new-run' },
        activeRequestMessageIdsByThread: { a: 'request' },
        runPhasesByThread: { a: 'preparing' },
        messages: {
          a: [
            {
              id: 'old-answer',
              threadId: 'a',
              parentMessageId: 'request',
              role: 'assistant',
              content: 'Previous reply',
              status: 'completed',
              createdAt: '2026-09-13T00:00:00Z'
            }
          ]
        }
      },
      'a'
    ),
    'loading'
  )
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
