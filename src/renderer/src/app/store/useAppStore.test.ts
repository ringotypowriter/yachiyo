import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SETTINGS, useAppStore } from './useAppStore'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'

function resetStore(): void {
  useAppStore.setState({
    activeRunId: null,
    activeRequestMessageId: null,
    activeRunThreadId: null,
    activeThreadId: null,
    composerValue: '',
    config: null,
    connectionStatus: 'connected',
    harnessEvents: {},
    initialized: false,
    isBootstrapping: false,
    lastError: null,
    messages: {},
    pendingAssistantMessages: {},
    runPhase: 'idle',
    runStatus: 'idle',
    settings: DEFAULT_SETTINGS,
    threads: []
  })
}

function withWindowApiMock(
  saveSettings: (input: { providerName?: string; model?: string }) => Promise<unknown>
): () => void {
  const globalScope = globalThis as typeof globalThis & {
    window?: {
      api: {
        yachiyo: {
          saveSettings: typeof saveSettings
        }
      }
    }
  }
  const originalWindow = globalScope.window

  Object.defineProperty(globalScope, 'window', {
    value: {
      api: {
        yachiyo: {
          saveSettings
        }
      }
    },
    configurable: true,
    writable: true
  })

  return () => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalScope, 'window')
      return
    }

    Object.defineProperty(globalScope, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true
    })
  }
}

test('applyServerEvent keeps a stopped placeholder when a run is cancelled before the first token', () => {
  resetStore()

  useAppStore.getState().applyServerEvent({
    type: 'run.created',
    eventId: 'event-run-created',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    requestMessageId: 'user-1'
  })
  useAppStore.getState().applyServerEvent({
    type: 'message.started',
    eventId: 'event-message-started',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    messageId: 'message-1',
    parentMessageId: 'user-1'
  })
  useAppStore.getState().applyServerEvent({
    type: 'run.cancelled',
    eventId: 'event-run-cancelled',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1'
  })

  const state = useAppStore.getState()

  assert.equal(state.activeRunId, null)
  assert.equal(state.activeRequestMessageId, null)
  assert.equal(state.activeRunThreadId, null)
  assert.equal(state.runPhase, 'idle')
  assert.equal(state.runStatus, 'cancelled')
  assert.equal(state.pendingAssistantMessages['run-1'], undefined)
  assert.deepEqual(state.messages['thread-1'], [
    {
      id: 'message-1',
      threadId: 'thread-1',
      role: 'assistant',
      parentMessageId: 'user-1',
      content: '',
      status: 'stopped',
      createdAt: TIMESTAMP
    }
  ])
})

test('applyServerEvent stays in preparing until the first token arrives', () => {
  resetStore()

  useAppStore.getState().applyServerEvent({
    type: 'run.created',
    eventId: 'event-run-created',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    requestMessageId: 'user-1'
  })

  let state = useAppStore.getState()
  assert.equal(state.activeRunId, 'run-1')
  assert.equal(state.activeRequestMessageId, 'user-1')
  assert.equal(state.activeRunThreadId, 'thread-1')
  assert.equal(state.runPhase, 'preparing')

  useAppStore.getState().applyServerEvent({
    type: 'message.started',
    eventId: 'event-message-started',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    messageId: 'message-1',
    parentMessageId: 'user-1'
  })

  state = useAppStore.getState()
  assert.equal(state.runPhase, 'preparing')
  assert.equal(state.messages['thread-1']?.[0]?.parentMessageId, 'user-1')
  assert.equal(state.messages['thread-1']?.[0]?.status, 'streaming')
  assert.equal(state.messages['thread-1']?.[0]?.content, '')

  useAppStore.getState().applyServerEvent({
    type: 'message.delta',
    eventId: 'event-message-delta',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    messageId: 'message-1',
    delta: 'H'
  })

  state = useAppStore.getState()
  assert.equal(state.runPhase, 'streaming')
  assert.equal(state.messages['thread-1']?.[0]?.content, 'H')
})

test('applyServerEvent replaces a thread snapshot after branch-aware history edits', () => {
  resetStore()

  useAppStore.setState({
    activeThreadId: 'thread-1',
    messages: {
      'thread-1': [
        {
          id: 'assistant-old',
          threadId: 'thread-1',
          role: 'assistant',
          parentMessageId: 'user-1',
          content: 'Outdated',
          status: 'completed',
          createdAt: TIMESTAMP
        }
      ]
    },
    threads: [
      {
        id: 'thread-1',
        title: 'Thread',
        updatedAt: TIMESTAMP
      }
    ]
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.state.replaced',
    eventId: 'event-thread-state-replaced',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-retry'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-retry',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Retry reply',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      }
    ]
  })

  const state = useAppStore.getState()

  assert.equal(state.threads[0]?.headMessageId, 'assistant-retry')
  assert.equal(state.messages['thread-1']?.length, 2)
  assert.equal(state.messages['thread-1']?.[1]?.parentMessageId, 'user-1')
  assert.equal(state.messages['thread-1']?.[1]?.content, 'Retry reply')
})

test('selectModel ignores changes while a run is active', async () => {
  resetStore()

  const calls: Array<{ providerName: string; model: string }> = []
  const restoreWindow = withWindowApiMock(async (input) => {
    calls.push({
      providerName: input.providerName ?? '',
      model: input.model ?? ''
    })

    return {
      ...DEFAULT_SETTINGS,
      providerName: input.providerName ?? '',
      model: input.model ?? ''
    }
  })

  try {
    useAppStore.setState({
      runPhase: 'preparing',
      runStatus: 'running'
    })

    await useAppStore.getState().selectModel('work', 'gpt-5')
    assert.equal(calls.length, 0)

    useAppStore.setState({
      runPhase: 'idle',
      runStatus: 'idle'
    })

    await useAppStore.getState().selectModel('work', 'gpt-5')
    assert.deepEqual(calls, [{ providerName: 'work', model: 'gpt-5' }])
  } finally {
    restoreWindow()
  }
})
