import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENABLED_TOOL_NAMES } from '../../../../shared/yachiyo/protocol.ts'
import {
  DEFAULT_SETTINGS,
  getEffectiveModel,
  getThreadEffectiveModel,
  useAppStore
} from './useAppStore.ts'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'
const READY_SETTINGS = {
  ...DEFAULT_SETTINGS,
  apiKey: 'sk-test',
  model: 'gpt-5',
  providerName: 'work'
}

function resetStore(): void {
  useAppStore.setState({
    activeArchivedThreadId: null,
    activeRunId: null,
    activeRunIdsByThread: {},
    activeRequestMessageId: null,
    activeRequestMessageIdsByThread: {},
    activeRunThreadId: null,
    activeThreadId: null,
    archivedThreads: [],
    composerDrafts: {},
    config: null,
    connectionStatus: 'connected',
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    harnessEvents: {},
    initialized: false,
    isBootstrapping: false,
    lastError: null,
    latestRunsByThread: {},
    externalThreads: [],
    showExternalThreads: false,
    runsByThread: {},
    messages: {},
    pendingAssistantMessages: {},
    pendingSteerMessages: {},
    pendingWorkspacePath: null,
    runPhase: 'idle',
    runPhasesByThread: {},
    runStatus: 'idle',
    runStatusesByThread: {},
    settings: DEFAULT_SETTINGS,
    threadListMode: 'active',
    threads: [],
    toolCalls: {}
  })
}

type YachiyoApiMock = Partial<Window['api']['yachiyo']>

function withWindowApiMock(mock: YachiyoApiMock): () => void {
  const globalScope = globalThis as typeof globalThis & {
    window?: {
      api: {
        yachiyo: YachiyoApiMock
      }
    }
  }
  const originalWindow = globalScope.window

  Object.defineProperty(globalScope, 'window', {
    value: {
      api: {
        yachiyo: {
          listSkills: async () => [],
          ...mock
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
  useAppStore.setState({ activeThreadId: 'thread-1' })

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
  assert.equal(state.runStatusesByThread['thread-1'], 'cancelled')
  assert.equal(state.pendingAssistantMessages['run-1'], undefined)
  assert.deepEqual(state.messages['thread-1'], [
    {
      id: 'message-1',
      threadId: 'thread-1',
      role: 'assistant',
      parentMessageId: 'user-1',
      content: '',
      textBlocks: [],
      status: 'stopped',
      createdAt: TIMESTAMP
    }
  ])
})

test('applyServerEvent clears pending reasoning when a run starts retrying', () => {
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
    type: 'message.reasoning.delta',
    eventId: 'event-message-reasoning',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    messageId: 'message-1',
    delta: 'Let me think...'
  })
  useAppStore.getState().applyServerEvent({
    type: 'run.retrying',
    eventId: 'event-run-retrying',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    attempt: 1,
    maxAttempts: 10,
    delayMs: 1000,
    error: 'net::ERR_CONNECTION_CLOSED'
  })

  const state = useAppStore.getState()
  const message = state.messages['thread-1']?.find((entry) => entry.id === 'message-1')

  assert.equal(message?.reasoning, undefined)
  assert.deepEqual(state.retryInfoByThread, {
    'thread-1': {
      attempt: 1,
      maxAttempts: 10,
      error: 'net::ERR_CONNECTION_CLOSED'
    }
  })
})

test('applyServerEvent stores recalled memory on the matching run', () => {
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
    type: 'run.memory.recalled',
    eventId: 'event-run-memory-recalled',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    requestMessageId: 'user-1',
    recalledMemoryEntries: ['Deploys start with staging smoke tests.'],
    recallDecision: {
      shouldRecall: true,
      score: 0.65,
      reasons: ['topic-novelty'],
      messagesSinceLastRecall: 1,
      charsSinceLastRecall: 42,
      idleMs: 0,
      noveltyScore: 0.75,
      novelTerms: ['system prompt', 'general']
    }
  })

  const state = useAppStore.getState()

  assert.deepEqual(state.runsByThread['thread-1'], [
    {
      id: 'run-1',
      threadId: 'thread-1',
      status: 'running',
      createdAt: TIMESTAMP,
      requestMessageId: 'user-1',
      recalledMemoryEntries: ['Deploys start with staging smoke tests.'],
      recallDecision: {
        shouldRecall: true,
        score: 0.65,
        reasons: ['topic-novelty'],
        messagesSinceLastRecall: 1,
        charsSinceLastRecall: 42,
        idleMs: 0,
        noveltyScore: 0.75,
        novelTerms: ['system prompt', 'general']
      }
    }
  ])
  assert.deepEqual(state.latestRunsByThread['thread-1'], {
    id: 'run-1',
    threadId: 'thread-1',
    status: 'running',
    createdAt: TIMESTAMP,
    requestMessageId: 'user-1',
    recalledMemoryEntries: ['Deploys start with staging smoke tests.'],
    recallDecision: {
      shouldRecall: true,
      score: 0.65,
      reasons: ['topic-novelty'],
      messagesSinceLastRecall: 1,
      charsSinceLastRecall: 42,
      idleMs: 0,
      noveltyScore: 0.75,
      novelTerms: ['system prompt', 'general']
    }
  })
})

test('applyServerEvent preserves compiled context sources after the run completes', () => {
  resetStore()

  const contextSources = [
    {
      kind: 'persona' as const,
      present: true
    }
  ]

  useAppStore.getState().applyServerEvent({
    type: 'run.created',
    eventId: 'event-run-created',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    requestMessageId: 'user-1'
  })
  useAppStore.getState().applyServerEvent({
    type: 'run.context.compiled',
    eventId: 'event-run-context-compiled',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    contextSources
  })
  useAppStore.getState().applyServerEvent({
    type: 'run.completed',
    eventId: 'event-run-completed',
    timestamp: '2026-03-15T00:00:05.000Z',
    threadId: 'thread-1',
    runId: 'run-1'
  })

  const state = useAppStore.getState()

  assert.equal(state.runsByThread['thread-1']?.[0]?.status, 'completed')
  assert.equal(state.runsByThread['thread-1']?.[0]?.completedAt, '2026-03-15T00:00:05.000Z')
  assert.deepEqual(state.runsByThread['thread-1']?.[0]?.contextSources, contextSources)
  assert.equal(state.latestRunsByThread['thread-1']?.status, 'completed')
  assert.equal(state.latestRunsByThread['thread-1']?.completedAt, '2026-03-15T00:00:05.000Z')
  assert.deepEqual(state.latestRunsByThread['thread-1']?.contextSources, contextSources)
})

test('applyServerEvent supports assistant-first runs without a request message id', () => {
  resetStore()
  useAppStore.setState({ activeThreadId: 'thread-compact' })

  useAppStore.getState().applyServerEvent({
    type: 'run.created',
    eventId: 'event-run-created',
    timestamp: TIMESTAMP,
    threadId: 'thread-compact',
    runId: 'run-compact'
  })
  useAppStore.getState().applyServerEvent({
    type: 'message.started',
    eventId: 'event-message-started',
    timestamp: TIMESTAMP,
    threadId: 'thread-compact',
    runId: 'run-compact',
    messageId: 'assistant-compact'
  })
  useAppStore.getState().applyServerEvent({
    type: 'message.delta',
    eventId: 'event-message-delta',
    timestamp: TIMESTAMP,
    threadId: 'thread-compact',
    runId: 'run-compact',
    messageId: 'assistant-compact',
    delta: 'Handoff'
  })

  const state = useAppStore.getState()

  assert.equal(state.activeRequestMessageId, null)
  assert.equal(state.activeRunId, 'run-compact')
  assert.equal(state.activeRunIdsByThread['thread-compact'], 'run-compact')
  assert.equal(state.messages['thread-compact']?.[0]?.role, 'assistant')
  assert.equal(state.messages['thread-compact']?.[0]?.parentMessageId, undefined)
  assert.equal(state.messages['thread-compact']?.[0]?.content, 'Handoff')
})

test('applyServerEvent stays in preparing until the first token arrives', () => {
  resetStore()
  useAppStore.setState({ activeThreadId: 'thread-1' })

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
  assert.equal(state.runPhasesByThread['thread-1'], 'preparing')

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
    toolCalls: {
      'thread-1': [
        {
          id: 'tool-old',
          runId: 'run-1',
          threadId: 'thread-1',
          toolName: 'read',
          status: 'completed',
          inputSummary: 'old.txt',
          outputSummary: 'lines 1-10',
          startedAt: TIMESTAMP,
          finishedAt: TIMESTAMP
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
    ],
    toolCalls: [
      {
        id: 'tool-new',
        runId: 'run-2',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'pwd && ls',
        outputSummary: 'exit 0',
        cwd: '/tmp/thread-1',
        startedAt: '2026-03-15T00:00:01.000Z',
        finishedAt: '2026-03-15T00:00:02.000Z'
      }
    ]
  })

  const state = useAppStore.getState()

  assert.equal(state.threads[0]?.headMessageId, 'assistant-retry')
  assert.equal(state.messages['thread-1']?.length, 2)
  assert.equal(state.messages['thread-1']?.[1]?.parentMessageId, 'user-1')
  assert.equal(state.messages['thread-1']?.[1]?.content, 'Retry reply')
  assert.equal(state.toolCalls['thread-1']?.length, 1)
  assert.equal(state.toolCalls['thread-1']?.[0]?.toolName, 'bash')
  assert.equal(state.toolCalls['thread-1']?.[0]?.cwd, '/tmp/thread-1')
})

test('applyServerEvent moves archived threads between active and archived collections', () => {
  resetStore()

  useAppStore.setState({
    activeThreadId: 'thread-1',
    threads: [
      {
        id: 'thread-1',
        title: 'Thread one',
        updatedAt: TIMESTAMP
      },
      {
        id: 'thread-2',
        title: 'Thread two',
        updatedAt: '2026-03-15T00:00:01.000Z'
      }
    ]
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.archived',
    eventId: 'event-thread-archived',
    timestamp: '2026-03-15T00:00:02.000Z',
    threadId: 'thread-1',
    thread: {
      id: 'thread-1',
      title: 'Thread one',
      updatedAt: '2026-03-15T00:00:02.000Z',
      archivedAt: '2026-03-15T00:00:02.000Z'
    }
  })

  let state = useAppStore.getState()
  assert.deepEqual(
    state.threads.map((thread) => thread.id),
    ['thread-2']
  )
  assert.deepEqual(
    state.archivedThreads.map((thread) => thread.id),
    ['thread-1']
  )
  assert.equal(state.activeThreadId, 'thread-2')

  useAppStore.setState({
    threadListMode: 'archived',
    activeArchivedThreadId: 'thread-1'
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.restored',
    eventId: 'event-thread-restored',
    timestamp: '2026-03-15T00:00:03.000Z',
    threadId: 'thread-1',
    thread: {
      id: 'thread-1',
      title: 'Thread one',
      updatedAt: '2026-03-15T00:00:03.000Z'
    }
  })

  state = useAppStore.getState()
  assert.deepEqual(
    state.threads.map((thread) => thread.id),
    ['thread-1', 'thread-2']
  )
  assert.deepEqual(state.archivedThreads, [])
  assert.equal(state.activeThreadId, 'thread-1')
  assert.equal(state.threadListMode, 'active')

  useAppStore.getState().applyServerEvent({
    type: 'thread.deleted',
    eventId: 'event-thread-deleted',
    timestamp: '2026-03-15T00:00:04.000Z',
    threadId: 'thread-1'
  })

  state = useAppStore.getState()
  assert.deepEqual(
    state.threads.map((thread) => thread.id),
    ['thread-2']
  )
  assert.equal(state.activeThreadId, 'thread-2')
})

test('applyServerEvent removes deleted external threads from the cached sidebar list', () => {
  resetStore()

  useAppStore.setState({
    externalThreads: [
      {
        id: 'external-thread',
        title: 'External thread',
        updatedAt: TIMESTAMP,
        source: 'discord'
      },
      {
        id: 'external-thread-2',
        title: 'External thread 2',
        updatedAt: '2026-03-15T00:00:01.000Z',
        source: 'discord'
      }
    ],
    showExternalThreads: true
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.deleted',
    eventId: 'event-external-thread-deleted',
    timestamp: '2026-03-15T00:00:02.000Z',
    threadId: 'external-thread'
  })

  const state = useAppStore.getState()

  assert.deepEqual(
    state.externalThreads.map((thread) => thread.id),
    ['external-thread-2']
  )
  assert.equal(state.showExternalThreads, true)
})

test('applyServerEvent retargets the active request when an active thread head moves to a steer user', () => {
  resetStore()

  useAppStore.setState({
    activeRunIdsByThread: {
      'thread-1': 'run-1'
    },
    activeRequestMessageIdsByThread: {
      'thread-1': 'user-1'
    },
    activeRunId: 'run-1',
    activeRequestMessageId: 'user-1',
    activeRunThreadId: 'thread-1',
    activeThreadId: 'thread-1',
    messages: {
      'thread-1': [
        {
          id: 'user-1',
          threadId: 'thread-1',
          role: 'user',
          content: 'Original request',
          status: 'completed',
          createdAt: TIMESTAMP
        },
        {
          id: 'user-steer',
          threadId: 'thread-1',
          parentMessageId: 'user-1',
          role: 'user',
          content: 'Use the screenshot instead',
          status: 'completed',
          createdAt: '2026-03-15T00:00:01.000Z'
        }
      ]
    },
    threads: [
      {
        id: 'thread-1',
        title: 'Thread',
        updatedAt: TIMESTAMP,
        headMessageId: 'user-1'
      }
    ]
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.updated',
    eventId: 'event-thread-updated',
    timestamp: '2026-03-15T00:00:01.000Z',
    threadId: 'thread-1',
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: '2026-03-15T00:00:01.000Z',
      headMessageId: 'user-steer'
    }
  })

  const state = useAppStore.getState()

  assert.equal(state.activeRequestMessageId, 'user-steer')
  assert.equal(state.threads[0]?.headMessageId, 'user-steer')
})

test('applyServerEvent keeps the steer request visible after thread replacement during an active run', () => {
  resetStore()

  useAppStore.setState({
    activeRunIdsByThread: {
      'thread-1': 'run-1'
    },
    activeRequestMessageIdsByThread: {
      'thread-1': 'user-1'
    },
    activeRunId: 'run-1',
    activeRequestMessageId: 'user-1',
    activeRunThreadId: 'thread-1',
    activeThreadId: 'thread-1',
    messages: {
      'thread-1': [
        {
          id: 'user-1',
          threadId: 'thread-1',
          role: 'user',
          content: 'Original request',
          status: 'completed',
          createdAt: TIMESTAMP
        }
      ]
    },
    threads: [
      {
        id: 'thread-1',
        title: 'Thread',
        updatedAt: TIMESTAMP,
        headMessageId: 'user-1'
      }
    ]
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.state.replaced',
    eventId: 'event-thread-state-replaced-steer',
    timestamp: '2026-03-15T00:00:02.000Z',
    threadId: 'thread-1',
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: '2026-03-15T00:00:02.000Z',
      headMessageId: 'user-steer'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Original request',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'user-steer',
        threadId: 'thread-1',
        parentMessageId: 'user-1',
        role: 'user',
        content: 'Use the screenshot instead',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      }
    ],
    toolCalls: []
  })

  const state = useAppStore.getState()

  assert.equal(state.activeRequestMessageId, 'user-steer')
  assert.deepEqual(
    state.messages['thread-1']?.map((message) => message.id),
    ['user-1', 'user-steer']
  )
})

test('applyServerEvent upserts live tool activity for the current thread', () => {
  resetStore()

  useAppStore.getState().applyServerEvent({
    type: 'tool.updated',
    eventId: 'event-tool-started',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    toolCall: {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'bash',
      status: 'running',
      inputSummary: 'pwd && ls',
      startedAt: TIMESTAMP
    }
  })
  useAppStore.getState().applyServerEvent({
    type: 'tool.updated',
    eventId: 'event-tool-finished',
    timestamp: '2026-03-15T00:00:01.000Z',
    threadId: 'thread-1',
    runId: 'run-1',
    toolCall: {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'bash',
      status: 'completed',
      inputSummary: 'pwd && ls',
      outputSummary: 'exit 0',
      cwd: '/tmp/thread-1',
      startedAt: TIMESTAMP,
      finishedAt: '2026-03-15T00:00:01.000Z'
    }
  })

  const state = useAppStore.getState()

  assert.equal(state.toolCalls['thread-1']?.length, 1)
  assert.equal(state.toolCalls['thread-1']?.[0]?.status, 'completed')
  assert.equal(state.toolCalls['thread-1']?.[0]?.cwd, '/tmp/thread-1')
})

test('applyServerEvent starts a new assistant text block after a tool update', () => {
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
    type: 'message.delta',
    eventId: 'event-message-delta-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    messageId: 'message-1',
    delta: 'Before tool'
  })
  useAppStore.getState().applyServerEvent({
    type: 'tool.updated',
    eventId: 'event-tool-started',
    timestamp: '2026-03-15T00:00:01.000Z',
    threadId: 'thread-1',
    runId: 'run-1',
    toolCall: {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'bash',
      status: 'running',
      inputSummary: 'pwd',
      startedAt: '2026-03-15T00:00:01.000Z'
    }
  })
  useAppStore.getState().applyServerEvent({
    type: 'message.delta',
    eventId: 'event-message-delta-2',
    timestamp: '2026-03-15T00:00:02.000Z',
    threadId: 'thread-1',
    runId: 'run-1',
    messageId: 'message-1',
    delta: 'After tool'
  })

  const message = useAppStore.getState().messages['thread-1']?.[0]

  assert.equal(message?.content, 'Before toolAfter tool')
  assert.deepEqual(
    message?.textBlocks?.map((textBlock) => ({
      content: textBlock.content,
      createdAt: textBlock.createdAt
    })),
    [
      {
        content: 'Before tool',
        createdAt: TIMESTAMP
      },
      {
        content: 'After tool',
        createdAt: '2026-03-15T00:00:02.000Z'
      }
    ]
  )
})

test('selectModel ignores changes while a run is active', async () => {
  resetStore()

  // Use a thread override path (active thread) to verify the guard applies regardless of route
  const overrideCalls: Array<{ providerName: string; model: string }> = []
  const restoreWindow = withWindowApiMock({
    setThreadModelOverride: async (input) => {
      if (input.modelOverride) {
        overrideCalls.push({
          providerName: input.modelOverride.providerName,
          model: input.modelOverride.model
        })
      }
      return { id: input.threadId, title: 'Thread', updatedAt: TIMESTAMP }
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      threads: [{ id: 'thread-1', title: 'Thread', updatedAt: TIMESTAMP }],
      runPhase: 'preparing',
      runPhasesByThread: {
        'thread-1': 'preparing'
      },
      runStatus: 'running',
      runStatusesByThread: {
        'thread-1': 'running'
      }
    })

    await useAppStore.getState().selectModel('work', 'gpt-5')
    assert.equal(overrideCalls.length, 0)

    useAppStore.setState({
      runPhase: 'idle',
      runPhasesByThread: {
        'thread-1': 'idle'
      },
      runStatus: 'idle',
      runStatusesByThread: {
        'thread-1': 'idle'
      }
    })

    await useAppStore.getState().selectModel('work', 'gpt-5')
    assert.deepEqual(overrideCalls, [{ providerName: 'work', model: 'gpt-5' }])
  } finally {
    restoreWindow()
  }
})

test('setEnabledTools persists one shared tool preference across thread switches', async () => {
  resetStore()

  const calls: string[][] = []
  const restoreWindow = withWindowApiMock({
    saveToolPreferences: async (input) => {
      const enabledTools = input.enabledTools ?? []
      calls.push(enabledTools)

      return {
        enabledTools,
        providers: []
      }
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      config: {
        enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
        providers: []
      },
      threads: [
        {
          id: 'thread-1',
          title: 'Thread one',
          updatedAt: TIMESTAMP
        },
        {
          id: 'thread-2',
          title: 'Thread two',
          updatedAt: TIMESTAMP
        }
      ]
    })

    await useAppStore.getState().setEnabledTools(['read', 'bash'])

    let state = useAppStore.getState()
    assert.deepEqual(calls, [['read', 'bash']])
    assert.deepEqual(state.enabledTools, ['read', 'bash'])

    state.setActiveThread('thread-2')
    state = useAppStore.getState()
    assert.equal(state.activeThreadId, 'thread-2')
    assert.deepEqual(state.enabledTools, ['read', 'bash'])
  } finally {
    restoreWindow()
  }
})

test('setActiveThread derives run state from the selected thread only', () => {
  resetStore()

  useAppStore.setState({
    activeThreadId: 'thread-1',
    activeRunIdsByThread: {
      'thread-1': 'run-1'
    },
    activeRequestMessageIdsByThread: {
      'thread-1': 'user-1'
    },
    runPhasesByThread: {
      'thread-1': 'streaming'
    },
    runStatusesByThread: {
      'thread-1': 'running',
      'thread-2': 'idle'
    },
    threads: [
      {
        id: 'thread-1',
        title: 'Thread one',
        updatedAt: TIMESTAMP,
        headMessageId: 'user-1'
      },
      {
        id: 'thread-2',
        title: 'Thread two',
        updatedAt: '2026-03-15T00:00:01.000Z'
      }
    ]
  })

  useAppStore.getState().setActiveThread('thread-2')

  let state = useAppStore.getState()
  assert.equal(state.activeRunId, null)
  assert.equal(state.activeRequestMessageId, null)
  assert.equal(state.activeRunThreadId, null)
  assert.equal(state.runPhase, 'idle')
  assert.equal(state.runStatus, 'idle')

  useAppStore.getState().setActiveThread('thread-1')

  state = useAppStore.getState()
  assert.equal(state.activeRunId, 'run-1')
  assert.equal(state.activeRequestMessageId, 'user-1')
  assert.equal(state.activeRunThreadId, 'thread-1')
  assert.equal(state.runPhase, 'streaming')
  assert.equal(state.runStatus, 'running')
})

test('sendMessage restores per-thread drafts and clears only the sent thread on success', async () => {
  resetStore()

  const calls: Array<{ content: string; enabledTools?: string[]; threadId: string }> = []
  const restoreWindow = withWindowApiMock({
    sendChat: async (input) => {
      calls.push({
        content: input.content,
        enabledTools: input.enabledTools,
        threadId: input.threadId
      })

      return {
        kind: 'run-started',
        runId: 'run-1',
        thread: {
          id: input.threadId,
          title: 'Thread one',
          updatedAt: TIMESTAMP
        },
        userMessage: {
          id: 'user-1',
          threadId: input.threadId,
          role: 'user',
          content: input.content,
          status: 'completed',
          createdAt: TIMESTAMP
        }
      }
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      composerDrafts: {
        'thread-1': {
          text: 'Alpha',
          images: [],
          files: []
        },
        'thread-2': {
          text: 'Bravo',
          images: [],
          files: []
        }
      },
      messages: {
        'thread-1': [],
        'thread-2': []
      },
      enabledTools: ['read', 'bash'],
      settings: READY_SETTINGS,
      threads: [
        {
          id: 'thread-1',
          title: 'Thread one',
          updatedAt: TIMESTAMP
        },
        {
          id: 'thread-2',
          title: 'Thread two',
          updatedAt: TIMESTAMP
        }
      ]
    })

    await useAppStore.getState().sendMessage()

    let state = useAppStore.getState()
    assert.deepEqual(calls, [
      {
        content: 'Alpha',
        enabledTools: ['read', 'bash'],
        threadId: 'thread-1'
      }
    ])
    assert.equal(state.composerDrafts['thread-1'], undefined)
    assert.equal(state.composerDrafts['thread-2']?.text, 'Bravo')
    assert.equal(state.messages['thread-1']?.[0]?.content, 'Alpha')
    assert.equal(state.activeRunId, 'run-1')
    assert.equal(state.activeRequestMessageId, 'user-1')
    assert.equal(state.activeRunThreadId, 'thread-1')
    assert.equal(state.runPhase, 'preparing')
    assert.equal(state.runStatus, 'running')

    state.setActiveThread('thread-2')
    state = useAppStore.getState()
    assert.equal(state.composerDrafts['thread-2']?.text, 'Bravo')
  } finally {
    restoreWindow()
  }
})

test('sendMessage routes active-run steer through the ordinary message path with images', async () => {
  resetStore()

  const calls: Array<{
    content: string
    enabledTools?: string[]
    images?: Array<{ dataUrl: string; filename?: string; mediaType: string }>
    mode?: string
    threadId: string
  }> = []
  const restoreWindow = withWindowApiMock({
    sendChat: async (input) => {
      calls.push({
        content: input.content,
        enabledTools: input.enabledTools,
        images: input.images,
        mode: input.mode,
        threadId: input.threadId
      })

      return {
        kind: 'active-run-steer',
        runId: 'run-1',
        thread: {
          id: input.threadId,
          title: 'Thread one',
          updatedAt: TIMESTAMP,
          headMessageId: 'user-steer'
        },
        userMessage: {
          id: 'user-steer',
          threadId: input.threadId,
          parentMessageId: 'user-1',
          role: 'user',
          content: input.content,
          images: input.images,
          status: 'completed',
          createdAt: TIMESTAMP
        }
      }
    }
  })

  try {
    useAppStore.setState({
      activeRunIdsByThread: {
        'thread-1': 'run-1'
      },
      activeRequestMessageIdsByThread: {
        'thread-1': 'user-1'
      },
      activeRunId: 'run-1',
      activeRequestMessageId: 'user-1',
      activeRunThreadId: 'thread-1',
      activeThreadId: 'thread-1',
      composerDrafts: {
        'thread-1': {
          text: 'Use the screenshot',
          images: [
            {
              id: 'draft-image-1',
              status: 'ready',
              dataUrl: 'data:image/png;base64,AAAA',
              mediaType: 'image/png',
              filename: 'diagram.png'
            }
          ],
          files: []
        }
      },
      enabledTools: ['read', 'bash'],
      messages: {
        'thread-1': [
          {
            id: 'user-1',
            threadId: 'thread-1',
            role: 'user',
            content: 'Original request',
            status: 'completed',
            createdAt: TIMESTAMP
          }
        ]
      },
      settings: READY_SETTINGS,
      threads: [
        {
          id: 'thread-1',
          title: 'Thread one',
          updatedAt: TIMESTAMP,
          headMessageId: 'user-1'
        }
      ]
    })

    await useAppStore.getState().sendMessage('steer')

    const state = useAppStore.getState()

    assert.deepEqual(calls, [
      {
        content: 'Use the screenshot',
        enabledTools: ['read', 'bash'],
        images: [
          {
            dataUrl: 'data:image/png;base64,AAAA',
            mediaType: 'image/png',
            filename: 'diagram.png'
          }
        ],
        mode: 'steer',
        threadId: 'thread-1'
      }
    ])
    assert.equal(state.activeRunId, 'run-1')
    assert.equal(state.activeRequestMessageId, 'user-steer')
    assert.equal(state.activeRunThreadId, 'thread-1')
    assert.equal(state.composerDrafts['thread-1'], undefined)
    assert.equal(state.messages['thread-1']?.length, 2)
    assert.deepEqual(state.messages['thread-1']?.[1]?.images, [
      {
        dataUrl: 'data:image/png;base64,AAAA',
        mediaType: 'image/png',
        filename: 'diagram.png'
      }
    ])
  } finally {
    restoreWindow()
  }
})

test('sendMessage keeps a tool-waiting steer as a temporary pending marker until it is truly sent', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    sendChat: async (input) => ({
      kind: 'active-run-steer-pending',
      runId: 'run-1',
      thread: {
        id: input.threadId,
        title: 'Thread one',
        updatedAt: TIMESTAMP,
        headMessageId: 'user-1'
      }
    })
  })

  try {
    useAppStore.setState({
      activeRunIdsByThread: {
        'thread-1': 'run-1'
      },
      activeRequestMessageIdsByThread: {
        'thread-1': 'user-1'
      },
      activeRunId: 'run-1',
      activeRequestMessageId: 'user-1',
      activeRunThreadId: 'thread-1',
      activeThreadId: 'thread-1',
      composerDrafts: {
        'thread-1': {
          text: 'Wait for the tool result first',
          images: [],
          files: []
        }
      },
      messages: {
        'thread-1': [
          {
            id: 'user-1',
            threadId: 'thread-1',
            role: 'user',
            content: 'Original request',
            status: 'completed',
            createdAt: TIMESTAMP
          }
        ]
      },
      settings: READY_SETTINGS,
      threads: [
        {
          id: 'thread-1',
          title: 'Thread one',
          updatedAt: TIMESTAMP,
          headMessageId: 'user-1'
        }
      ]
    })

    await useAppStore.getState().sendMessage('steer')

    let state = useAppStore.getState()
    assert.equal(state.messages['thread-1']?.length, 1)
    assert.equal(state.activeRequestMessageId, 'user-1')
    assert.equal(state.activeRequestMessageIdsByThread['thread-1'], 'user-1')
    assert.equal(state.pendingSteerMessages['thread-1']?.content, 'Wait for the tool result first')

    useAppStore.getState().applyServerEvent({
      type: 'thread.state.replaced',
      eventId: 'event-thread-state-replaced-pending-steer',
      timestamp: '2026-03-15T00:00:02.000Z',
      threadId: 'thread-1',
      thread: {
        id: 'thread-1',
        title: 'Thread one',
        updatedAt: '2026-03-15T00:00:02.000Z',
        headMessageId: 'user-steer'
      },
      messages: [
        {
          id: 'user-1',
          threadId: 'thread-1',
          role: 'user',
          content: 'Original request',
          status: 'completed',
          createdAt: TIMESTAMP
        },
        {
          id: 'user-steer',
          threadId: 'thread-1',
          parentMessageId: 'user-1',
          role: 'user',
          content: 'Wait for the tool result first',
          status: 'completed',
          createdAt: '2026-03-15T00:00:01.000Z'
        }
      ],
      toolCalls: []
    })

    state = useAppStore.getState()
    assert.equal(state.pendingSteerMessages['thread-1'], undefined)
    assert.equal(state.activeRequestMessageId, 'user-steer')
    assert.deepEqual(
      state.messages['thread-1']?.map((message) => message.id),
      ['user-1', 'user-steer']
    )
  } finally {
    restoreWindow()
  }
})

test('sendMessage replaces the queued follow-up for an active run', async () => {
  resetStore()

  const calls: Array<{
    content: string
    enabledSkillNames?: string[]
    mode?: string
    threadId: string
  }> = []
  const restoreWindow = withWindowApiMock({
    sendChat: async (input) => {
      calls.push({
        content: input.content,
        enabledSkillNames: input.enabledSkillNames,
        mode: input.mode,
        threadId: input.threadId
      })

      return {
        kind: 'active-run-follow-up',
        runId: 'run-1',
        thread: {
          id: input.threadId,
          title: 'Thread one',
          updatedAt: TIMESTAMP,
          headMessageId: 'user-1',
          queuedFollowUpMessageId: 'user-follow-up-2'
        },
        replacedMessageId: 'user-follow-up-1',
        userMessage: {
          id: 'user-follow-up-2',
          threadId: input.threadId,
          parentMessageId: 'user-1',
          role: 'user',
          content: input.content,
          status: 'completed',
          createdAt: TIMESTAMP
        }
      }
    }
  })

  try {
    useAppStore.setState({
      activeRunIdsByThread: {
        'thread-1': 'run-1'
      },
      activeRequestMessageIdsByThread: {
        'thread-1': 'user-1'
      },
      activeRunId: 'run-1',
      activeRequestMessageId: 'user-1',
      activeRunThreadId: 'thread-1',
      activeThreadId: 'thread-1',
      config: {
        ...DEFAULT_SETTINGS,
        providers: [],
        skills: {
          enabled: ['workspace-refactor']
        }
      },
      composerDrafts: {
        'thread-1': {
          text: 'Second queued follow-up',
          images: [],
          files: []
        }
      },
      messages: {
        'thread-1': [
          {
            id: 'user-1',
            threadId: 'thread-1',
            role: 'user',
            content: 'Original request',
            status: 'completed',
            createdAt: '2026-03-15T00:00:00.000Z'
          },
          {
            id: 'user-follow-up-1',
            threadId: 'thread-1',
            parentMessageId: 'user-1',
            role: 'user',
            content: 'First queued follow-up',
            status: 'completed',
            createdAt: '2026-03-15T00:00:01.000Z'
          }
        ]
      },
      settings: READY_SETTINGS,
      threads: [
        {
          id: 'thread-1',
          title: 'Thread one',
          updatedAt: TIMESTAMP,
          headMessageId: 'user-1',
          queuedFollowUpMessageId: 'user-follow-up-1'
        }
      ]
    })

    await useAppStore.getState().sendMessage('follow-up')

    const state = useAppStore.getState()

    assert.deepEqual(calls, [
      {
        content: 'Second queued follow-up',
        enabledSkillNames: ['workspace-refactor'],
        mode: 'follow-up',
        threadId: 'thread-1'
      }
    ])
    assert.equal(state.activeRunId, 'run-1')
    assert.equal(state.activeRequestMessageId, 'user-1')
    assert.equal(state.composerDrafts['thread-1'], undefined)
    assert.deepEqual(
      state.messages['thread-1']?.map((message) => message.id),
      ['user-1', 'user-follow-up-2']
    )
    assert.equal(state.threads[0]?.queuedFollowUpMessageId, 'user-follow-up-2')
  } finally {
    restoreWindow()
  }
})

test('retryMessage marks the accepted run as active immediately', async () => {
  resetStore()

  const calls: Array<{
    enabledSkillNames?: string[]
    enabledTools?: string[]
    messageId: string
    threadId: string
  }> = []
  const restoreWindow = withWindowApiMock({
    retryMessage: async (input) => {
      calls.push({
        enabledSkillNames: input.enabledSkillNames,
        enabledTools: input.enabledTools,
        messageId: input.messageId,
        threadId: input.threadId
      })

      return {
        runId: 'run-retry-1',
        thread: {
          id: input.threadId,
          title: 'Thread one',
          updatedAt: TIMESTAMP
        },
        requestMessageId: 'user-1',
        sourceAssistantMessageId: input.messageId
      }
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      messages: {
        'thread-1': [
          {
            id: 'user-1',
            threadId: 'thread-1',
            role: 'user',
            content: 'Alpha',
            status: 'completed',
            createdAt: TIMESTAMP
          },
          {
            id: 'assistant-1',
            threadId: 'thread-1',
            parentMessageId: 'user-1',
            role: 'assistant',
            content: 'Bravo',
            status: 'completed',
            createdAt: TIMESTAMP
          }
        ]
      },
      enabledTools: ['read', 'edit'],
      config: {
        ...DEFAULT_SETTINGS,
        providers: [],
        skills: {
          enabled: ['workspace-refactor']
        }
      },
      settings: READY_SETTINGS,
      threads: [
        {
          id: 'thread-1',
          title: 'Thread one',
          updatedAt: TIMESTAMP
        }
      ]
    })

    await useAppStore.getState().retryMessage('assistant-1')

    const state = useAppStore.getState()
    assert.deepEqual(calls, [
      {
        enabledSkillNames: ['workspace-refactor'],
        enabledTools: ['read', 'edit'],
        messageId: 'assistant-1',
        threadId: 'thread-1'
      }
    ])
    assert.equal(state.activeRunId, 'run-retry-1')
    assert.equal(state.activeRequestMessageId, 'user-1')
    assert.equal(state.activeRunThreadId, 'thread-1')
    assert.equal(state.runPhase, 'preparing')
    assert.equal(state.runStatus, 'running')
    assert.equal(state.lastError, null)
  } finally {
    restoreWindow()
  }
})

test('createBranch switches to a blank draft in the destination thread', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    createBranch: async (input) => ({
      thread: {
        id: 'thread-2',
        title: 'Branched',
        updatedAt: TIMESTAMP,
        branchFromThreadId: input.threadId,
        branchFromMessageId: input.messageId
      },
      messages: [],
      toolCalls: []
    })
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      composerDrafts: {
        'thread-1': {
          text: 'Keep me here',
          images: [],
          files: []
        }
      },
      messages: {
        'thread-1': []
      },
      threads: [
        {
          id: 'thread-1',
          title: 'Original',
          updatedAt: TIMESTAMP
        }
      ]
    })

    await useAppStore.getState().createBranch('message-1')

    const state = useAppStore.getState()
    assert.equal(state.activeThreadId, 'thread-2')
    assert.equal(state.composerDrafts['thread-1']?.text, 'Keep me here')
    assert.equal(state.composerDrafts['thread-2'], undefined)
  } finally {
    restoreWindow()
  }
})

test('compactThreadToAnotherThread switches into the destination thread and starts a run', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    compactThreadToAnotherThread: async (input) => ({
      runId: 'run-compact-1',
      sourceThreadId: input.threadId,
      thread: {
        id: 'thread-2',
        title: 'New Chat',
        updatedAt: TIMESTAMP
      }
    })
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      composerDrafts: {
        'thread-1': {
          text: 'Keep me here too',
          images: [],
          files: []
        }
      },
      messages: {
        'thread-1': []
      },
      threads: [
        {
          id: 'thread-1',
          title: 'Original',
          updatedAt: TIMESTAMP
        }
      ]
    })

    await useAppStore.getState().compactThreadToAnotherThread()

    const state = useAppStore.getState()
    assert.equal(state.activeThreadId, 'thread-2')
    assert.equal(state.activeRunId, 'run-compact-1')
    assert.equal(state.activeRunThreadId, 'thread-2')
    assert.equal(state.activeRequestMessageId, null)
    assert.equal(state.runPhase, 'preparing')
    assert.equal(state.runStatus, 'running')
    assert.equal(state.composerDrafts['thread-1']?.text, 'Keep me here too')
    assert.equal(state.composerDrafts['thread-2'], undefined)
  } finally {
    restoreWindow()
  }
})

test('sendMessage keeps draft text and images when the first send fails after auto-creating a thread', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    createThread: async () => ({
      id: 'thread-1',
      title: 'New Chat',
      updatedAt: TIMESTAMP
    }),
    sendChat: async () => {
      throw new Error('Provider offline')
    }
  })

  try {
    useAppStore.setState({
      composerDrafts: {
        __new__: {
          text: 'Keep this draft',
          images: [
            {
              id: 'image-1',
              status: 'ready',
              dataUrl: 'data:image/png;base64,AAAA',
              mediaType: 'image/png',
              filename: 'diagram.png'
            }
          ],
          files: []
        }
      },
      settings: READY_SETTINGS
    })

    await useAppStore.getState().sendMessage()

    const state = useAppStore.getState()
    assert.equal(state.activeThreadId, 'thread-1')
    assert.equal(state.lastError, 'Provider offline')
    assert.equal(state.composerDrafts.__new__, undefined)
    assert.equal(state.composerDrafts['thread-1']?.text, 'Keep this draft')
    assert.equal(state.composerDrafts['thread-1']?.images[0]?.filename, 'diagram.png')
  } finally {
    restoreWindow()
  }
})

test('sendMessage creates a privacy-mode thread from an essential preset', async () => {
  resetStore()

  const createThreadCalls: Array<
    { workspacePath?: string; createdFromEssentialId?: string; privacyMode?: boolean } | undefined
  > = []
  const restoreWindow = withWindowApiMock({
    createThread: async (input) => {
      createThreadCalls.push(input)
      return {
        id: 'thread-1',
        title: 'New Chat',
        updatedAt: TIMESTAMP,
        ...(input?.privacyMode ? { privacyMode: true } : {})
      }
    },
    sendChat: async (input) => ({
      kind: 'run-started',
      runId: 'run-1',
      thread: {
        id: input.threadId,
        title: 'New Chat',
        updatedAt: TIMESTAMP,
        privacyMode: true
      },
      userMessage: {
        id: 'user-1',
        threadId: input.threadId,
        role: 'user',
        content: input.content,
        status: 'completed',
        createdAt: TIMESTAMP
      }
    }),
    setThreadIcon: async (input) => ({
      id: input.threadId,
      title: 'New Chat',
      updatedAt: TIMESTAMP,
      icon: input.icon ?? undefined,
      privacyMode: true
    })
  })

  try {
    useAppStore.setState({
      activeEssentialId: 'essential-private',
      composerDrafts: {
        __new__: {
          text: 'Keep this private',
          images: [],
          files: []
        }
      },
      config: {
        providers: [],
        essentials: [
          {
            id: 'essential-private',
            icon: '🔒',
            iconType: 'emoji',
            label: 'Private',
            privacyMode: true,
            order: 0
          }
        ]
      },
      settings: READY_SETTINGS
    })

    await useAppStore.getState().sendMessage()

    const state = useAppStore.getState()
    assert.deepEqual(createThreadCalls, [
      {
        createdFromEssentialId: 'essential-private',
        privacyMode: true
      }
    ])
    assert.equal(state.threads[0]?.privacyMode, true)
  } finally {
    restoreWindow()
  }
})

test('createNewThread preserves the drafted workspace selection', async () => {
  resetStore()

  const createThreadCalls: Array<{ workspacePath?: string } | undefined> = []
  const restoreWindow = withWindowApiMock({
    createThread: async (input) => {
      createThreadCalls.push(input)
      return {
        id: 'thread-1',
        title: 'New Chat',
        updatedAt: TIMESTAMP,
        ...(input?.workspacePath ? { workspacePath: input.workspacePath } : {})
      }
    }
  })

  try {
    useAppStore.setState({
      pendingWorkspacePath: '/tmp/pinned-workspace'
    })

    await useAppStore.getState().createNewThread()

    const state = useAppStore.getState()
    assert.deepEqual(createThreadCalls, [{ workspacePath: '/tmp/pinned-workspace' }])
    assert.equal(state.activeThreadId, 'thread-1')
    assert.equal(state.pendingWorkspacePath, null)
    assert.equal(state.threads[0]?.workspacePath, '/tmp/pinned-workspace')
  } finally {
    restoreWindow()
  }
})

test('createNewThread reuses an existing blank New Chat instead of creating another thread', async () => {
  resetStore()

  let createThreadCallCount = 0
  const restoreWindow = withWindowApiMock({
    createThread: async () => {
      createThreadCallCount += 1
      return {
        id: 'thread-2',
        title: 'New Chat',
        updatedAt: TIMESTAMP
      }
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-older',
      messages: {
        'thread-1': [],
        'thread-older': [
          {
            id: 'message-1',
            threadId: 'thread-older',
            role: 'user',
            content: 'hello',
            status: 'completed',
            createdAt: TIMESTAMP
          }
        ]
      },
      threads: [
        {
          id: 'thread-1',
          title: 'New Chat',
          updatedAt: TIMESTAMP
        },
        {
          id: 'thread-older',
          title: 'Existing',
          updatedAt: '2026-03-14T00:00:00.000Z',
          preview: 'hello',
          headMessageId: 'message-1'
        }
      ]
    })

    await useAppStore.getState().createNewThread()

    const state = useAppStore.getState()
    assert.equal(createThreadCallCount, 0)
    assert.equal(state.activeThreadId, 'thread-1')
    assert.equal(state.threads.length, 2)
  } finally {
    restoreWindow()
  }
})

test('createNewThread does not reuse a New Chat that already has unsent draft content', async () => {
  resetStore()

  const createThreadCalls: Array<{ workspacePath?: string } | undefined> = []
  const restoreWindow = withWindowApiMock({
    createThread: async (input) => {
      createThreadCalls.push(input)
      return {
        id: 'thread-2',
        title: 'New Chat',
        updatedAt: TIMESTAMP
      }
    }
  })

  try {
    useAppStore.setState({
      composerDrafts: {
        'thread-1': {
          text: 'Unsaved draft',
          images: [],
          files: []
        }
      },
      messages: {
        'thread-1': []
      },
      threads: [
        {
          id: 'thread-1',
          title: 'New Chat',
          updatedAt: TIMESTAMP
        }
      ]
    })

    await useAppStore.getState().createNewThread()

    const state = useAppStore.getState()
    assert.deepEqual(createThreadCalls, [undefined])
    assert.equal(state.activeThreadId, 'thread-2')
  } finally {
    restoreWindow()
  }
})

test('upsertComposerImage ignores late async updates after the placeholder was removed or cleared', () => {
  resetStore()

  useAppStore.getState().upsertComposerImage({
    id: 'image-1',
    status: 'loading',
    dataUrl: '',
    mediaType: 'image/png',
    filename: 'large.png'
  })
  useAppStore.getState().removeComposerImage('image-1')
  useAppStore.getState().upsertComposerImage({
    id: 'image-1',
    status: 'ready',
    dataUrl: 'data:image/png;base64,AAAA',
    mediaType: 'image/png',
    filename: 'large.png'
  })

  let state = useAppStore.getState()
  assert.equal(state.composerDrafts.__new__, undefined)

  useAppStore.getState().upsertComposerImage({
    id: 'image-2',
    status: 'loading',
    dataUrl: '',
    mediaType: 'image/png',
    filename: 'slow.png'
  })
  useAppStore.setState({ composerDrafts: {} })
  useAppStore.getState().upsertComposerImage({
    id: 'image-2',
    status: 'failed',
    dataUrl: '',
    mediaType: 'image/png',
    filename: 'slow.png',
    error: 'Unable to prepare this image.'
  })

  state = useAppStore.getState()
  assert.deepEqual(state.composerDrafts, {})
})

test('getEffectiveModel returns thread override when present', () => {
  const state = {
    activeThreadId: 'thread-1',
    pendingModelOverride: null,
    threads: [
      {
        id: 'thread-1',
        title: 'Thread one',
        updatedAt: TIMESTAMP,
        modelOverride: { providerName: 'work', model: 'gpt-5' }
      }
    ],
    settings: { ...DEFAULT_SETTINGS, providerName: 'backup', model: 'claude-opus-4-6' }
  }

  assert.deepEqual(getEffectiveModel(state), { providerName: 'work', model: 'gpt-5' })
})

test('getEffectiveModel falls back to settings when thread has no override', () => {
  const state = {
    activeThreadId: 'thread-1',
    pendingModelOverride: null,
    threads: [{ id: 'thread-1', title: 'Thread one', updatedAt: TIMESTAMP }],
    settings: { ...DEFAULT_SETTINGS, providerName: 'backup', model: 'claude-opus-4-6' }
  }

  assert.deepEqual(getEffectiveModel(state), { providerName: 'backup', model: 'claude-opus-4-6' })
})

test('getEffectiveModel falls back to settings when no active thread', () => {
  const state = {
    activeThreadId: null,
    pendingModelOverride: null,
    threads: [],
    settings: { ...DEFAULT_SETTINGS, providerName: 'work', model: 'gpt-5' }
  }

  assert.deepEqual(getEffectiveModel(state), { providerName: 'work', model: 'gpt-5' })
})

test('getEffectiveModel returns pendingModelOverride when no active thread', () => {
  const state = {
    activeThreadId: null,
    pendingModelOverride: { providerName: 'essential-provider', model: 'essential-model' },
    threads: [],
    settings: { ...DEFAULT_SETTINGS, providerName: 'work', model: 'gpt-5' }
  }

  assert.deepEqual(getEffectiveModel(state), {
    providerName: 'essential-provider',
    model: 'essential-model'
  })
})

test('getThreadEffectiveModel uses thread override by thread id', () => {
  const state = {
    threads: [
      {
        id: 'thread-a',
        title: 'Thread A',
        updatedAt: TIMESTAMP,
        modelOverride: { providerName: 'work', model: 'gpt-4.1' }
      },
      {
        id: 'thread-b',
        title: 'Thread B',
        updatedAt: TIMESTAMP
      }
    ],
    settings: { ...DEFAULT_SETTINGS, providerName: 'backup', model: 'claude-opus-4-6' }
  }

  assert.deepEqual(getThreadEffectiveModel(state, 'thread-a'), {
    providerName: 'work',
    model: 'gpt-4.1'
  })
  assert.deepEqual(getThreadEffectiveModel(state, 'thread-b'), {
    providerName: 'backup',
    model: 'claude-opus-4-6'
  })
})

test('selectModel sets thread override when active thread exists', async () => {
  resetStore()

  const overrideCalls: Array<{ threadId: string; providerName: string; model: string }> = []
  const restoreWindow = withWindowApiMock({
    setThreadModelOverride: async (input) => {
      if (input.modelOverride) {
        overrideCalls.push({
          threadId: input.threadId,
          providerName: input.modelOverride.providerName,
          model: input.modelOverride.model
        })
      }
      return {
        id: input.threadId,
        title: 'Thread',
        updatedAt: TIMESTAMP,
        modelOverride: input.modelOverride ?? undefined
      }
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      threads: [{ id: 'thread-1', title: 'Thread', updatedAt: TIMESTAMP }]
    })

    await useAppStore.getState().selectModel('work', 'gpt-5')

    assert.deepEqual(overrideCalls, [
      { threadId: 'thread-1', providerName: 'work', model: 'gpt-5' }
    ])
    const thread = useAppStore.getState().threads.find((t) => t.id === 'thread-1')
    assert.deepEqual(thread?.modelOverride, { providerName: 'work', model: 'gpt-5' })
  } finally {
    restoreWindow()
  }
})

test('clearThreadModelOverride removes thread model override', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    setThreadModelOverride: async (input) => ({
      id: input.threadId,
      title: 'Thread',
      updatedAt: TIMESTAMP
    })
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      threads: [
        {
          id: 'thread-1',
          title: 'Thread',
          updatedAt: TIMESTAMP,
          modelOverride: { providerName: 'work', model: 'gpt-5' }
        }
      ]
    })

    await useAppStore.getState().clearThreadModelOverride('thread-1')

    const thread = useAppStore.getState().threads.find((t) => t.id === 'thread-1')
    assert.equal(thread?.modelOverride, undefined)
  } finally {
    restoreWindow()
  }
})
