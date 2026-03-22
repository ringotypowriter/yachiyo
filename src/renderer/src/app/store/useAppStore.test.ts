import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENABLED_TOOL_NAMES } from '../../../../shared/yachiyo/protocol.ts'
import { DEFAULT_SETTINGS, useAppStore } from './useAppStore.ts'

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
    activeRequestMessageId: null,
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
    messages: {},
    pendingAssistantMessages: {},
    pendingSteerMessages: {},
    pendingWorkspacePath: null,
    runPhase: 'idle',
    runStatus: 'idle',
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
        yachiyo: mock
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

test('applyServerEvent retargets the active request when an active thread head moves to a steer user', () => {
  resetStore()

  useAppStore.setState({
    activeRunId: 'run-1',
    activeRequestMessageId: 'user-1',
    activeRunThreadId: 'thread-1',
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
    activeRunId: 'run-1',
    activeRequestMessageId: 'user-1',
    activeRunThreadId: 'thread-1',
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

test('selectModel ignores changes while a run is active', async () => {
  resetStore()

  const calls: Array<{ providerName: string; model: string }> = []
  const restoreWindow = withWindowApiMock({
    saveSettings: async (input) => {
      calls.push({
        providerName: input.providerName ?? '',
        model: input.model ?? ''
      })

      return {
        ...DEFAULT_SETTINGS,
        providerName: input.providerName ?? '',
        model: input.model ?? ''
      }
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
          images: []
        },
        'thread-2': {
          text: 'Bravo',
          images: []
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
          ]
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
      activeRunId: 'run-1',
      activeRequestMessageId: 'user-1',
      activeRunThreadId: 'thread-1',
      activeThreadId: 'thread-1',
      composerDrafts: {
        'thread-1': {
          text: 'Wait for the tool result first',
          images: []
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

  const calls: Array<{ content: string; mode?: string; threadId: string }> = []
  const restoreWindow = withWindowApiMock({
    sendChat: async (input) => {
      calls.push({
        content: input.content,
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
      activeRunId: 'run-1',
      activeRequestMessageId: 'user-1',
      activeRunThreadId: 'thread-1',
      activeThreadId: 'thread-1',
      composerDrafts: {
        'thread-1': {
          text: 'Second queued follow-up',
          images: []
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

  const calls: Array<{ enabledTools?: string[]; messageId: string; threadId: string }> = []
  const restoreWindow = withWindowApiMock({
    retryMessage: async (input) => {
      calls.push({
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
          images: []
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
          ]
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
