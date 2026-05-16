import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ENABLED_TOOL_NAMES } from '../../../../shared/yachiyo/protocol.ts'
import { DEFAULT_SIDEBAR_FILTER, DEFAULT_SETTINGS, useAppStore } from './useAppStore.ts'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'

function resetStore(): void {
  useAppStore.setState({
    activeArchivedThreadId: null,
    activeEssentialId: null,
    activeRunId: null,
    activeRunIdsByThread: {},
    activeRequestMessageId: null,
    activeRequestMessageIdsByThread: {},
    activeRunThreadId: null,
    activeThreadId: null,
    activeToasts: [],
    archivedThreads: [],
    composerDrafts: {},
    globalProcessingTasks: [],
    reasoningEffortByThread: {},
    config: null,
    connectionStatus: 'connected',
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    subagentActiveIdsByThread: {},
    subagentProgressTimelineByThread: {},
    subagentStateById: {},
    initialized: false,
    isBootstrapping: false,
    justDoneRunIdsByThread: {},
    lastError: null,
    latestRunsByThread: {},
    externalThreads: [],
    showExternalThreads: false,
    runsByThread: {},
    messages: {},
    pendingAssistantMessages: {},
    pendingAcpBinding: null,
    pendingModelOverride: null,
    pendingSteerMessages: {},
    pendingWorkspacePath: null,
    queuedToasts: [],
    runPhase: 'idle',
    runPhasesByThread: {},
    runStatus: 'idle',
    runStatusesByThread: {},
    settings: DEFAULT_SETTINGS,
    sidebarFilter: {
      ...DEFAULT_SIDEBAR_FILTER,
      colorTags: new Set(DEFAULT_SIDEBAR_FILTER.colorTags),
      workspacePaths: new Set(DEFAULT_SIDEBAR_FILTER.workspacePaths)
    },
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

function withDocumentFocusMock(input: { hidden: boolean; hasFocus: boolean }): () => void {
  const globalScope = globalThis as typeof globalThis & { document?: Partial<Document> }
  const originalDocument = globalScope.document

  Object.defineProperty(globalScope, 'document', {
    value: {
      hidden: input.hidden,
      hasFocus: () => input.hasFocus
    },
    configurable: true,
    writable: true
  })

  return () => {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalScope, 'document')
      return
    }

    Object.defineProperty(globalScope, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true
    })
  }
}

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

test('setActiveArchivedThread forces archived view while multi filters are active', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    markThreadAsRead: async ({ threadId }) => ({
      id: threadId,
      title: 'Archived thread',
      updatedAt: TIMESTAMP,
      archivedAt: TIMESTAMP,
      readAt: TIMESTAMP
    })
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      activeArchivedThreadId: null,
      archivedThreads: [
        {
          id: 'archived-1',
          title: 'Archived thread',
          updatedAt: TIMESTAMP,
          archivedAt: TIMESTAMP
        }
      ],
      sidebarFilter: {
        ...DEFAULT_SIDEBAR_FILTER,
        base: 'all',
        colorTags: new Set(['coral'])
      },
      threadListMode: 'active'
    })

    useAppStore.getState().setActiveArchivedThread('archived-1')

    const state = useAppStore.getState()
    assert.equal(state.activeArchivedThreadId, 'archived-1')
    assert.equal(state.sidebarFilter.base, 'archived')
    assert.deepEqual([...state.sidebarFilter.colorTags], ['coral'])
    assert.equal(state.threadListMode, 'archived')
    await Promise.resolve()
  } finally {
    restoreWindow()
  }
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

test('applyServerEvent updates and re-sorts cached external threads on thread.updated', () => {
  resetStore()

  useAppStore.setState({
    externalThreads: [
      {
        id: 'external-thread-old',
        title: 'Older external thread',
        updatedAt: '2026-03-15T00:00:01.000Z',
        source: 'discord'
      },
      {
        id: 'external-thread-new',
        title: 'Newer external thread',
        updatedAt: '2026-03-15T00:00:02.000Z',
        source: 'discord'
      }
    ],
    showExternalThreads: true
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.updated',
    eventId: 'event-external-thread-updated',
    timestamp: '2026-03-15T00:00:03.000Z',
    threadId: 'external-thread-old',
    thread: {
      id: 'external-thread-old',
      title: 'Older external thread',
      updatedAt: '2026-03-15T00:00:03.000Z',
      source: 'discord'
    }
  })

  const state = useAppStore.getState()

  assert.deepEqual(
    state.externalThreads.map((thread) => thread.id),
    ['external-thread-old', 'external-thread-new']
  )
})

test('applyServerEvent keeps hidden group probe threads out of cached external threads', () => {
  resetStore()

  useAppStore.setState({
    externalThreads: [
      {
        id: 'external-thread',
        title: 'Visible external thread',
        updatedAt: '2026-03-15T00:00:01.000Z',
        source: 'discord'
      }
    ],
    showExternalThreads: true
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.updated',
    eventId: 'event-group-probe-thread-updated',
    timestamp: '2026-03-15T00:00:02.000Z',
    threadId: 'group-probe-thread',
    thread: {
      id: 'group-probe-thread',
      title: 'Hidden group probe thread',
      updatedAt: '2026-03-15T00:00:02.000Z',
      source: 'discord',
      channelGroupId: 'group-1'
    }
  })

  const state = useAppStore.getState()

  assert.deepEqual(
    state.externalThreads.map((thread) => thread.id),
    ['external-thread']
  )
})

test('applyServerEvent treats owner DM threads as normal threads', () => {
  resetStore()

  useAppStore.setState({
    externalThreads: [
      {
        id: 'owner-dm-thread',
        title: 'Owner DM',
        updatedAt: '2026-03-15T00:00:01.000Z',
        source: 'telegram',
        channelUserId: 'tg-owner'
      },
      {
        id: 'guest-dm-thread',
        title: 'Guest DM',
        updatedAt: '2026-03-15T00:00:01.000Z',
        source: 'telegram',
        channelUserId: 'tg-guest'
      }
    ],
    showExternalThreads: true
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.updated',
    eventId: 'event-owner-dm-thread-updated',
    timestamp: '2026-03-15T00:00:02.000Z',
    threadId: 'owner-dm-thread',
    thread: {
      id: 'owner-dm-thread',
      title: 'Owner DM plan',
      updatedAt: '2026-03-15T00:00:02.000Z',
      source: 'telegram',
      channelUserId: 'tg-owner',
      channelUserRole: 'owner'
    }
  })

  const state = useAppStore.getState()

  assert.deepEqual(
    state.threads.map((thread) => thread.id),
    ['owner-dm-thread']
  )
  assert.deepEqual(
    state.externalThreads.map((thread) => thread.id),
    ['guest-dm-thread']
  )
})

test('applyServerEvent does not notify for owner DM runs started from an external channel', () => {
  resetStore()

  const notifications: Array<{ title: string; body?: string }> = []
  const restoreWindow = withWindowApiMock({
    showNotification: (input) => {
      notifications.push(input)
    }
  })
  const restoreDocument = withDocumentFocusMock({ hidden: true, hasFocus: false })

  try {
    useAppStore.setState({
      activeThreadId: 'local-thread',
      config: {
        enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
        general: {
          notifyRunCompleted: true
        },
        providers: []
      },
      messages: {
        'owner-dm-thread': [
          {
            id: 'assistant-1',
            threadId: 'owner-dm-thread',
            role: 'assistant',
            content: 'Done from DM',
            status: 'completed',
            createdAt: TIMESTAMP
          }
        ]
      },
      threads: [
        { id: 'local-thread', title: 'Local', updatedAt: TIMESTAMP },
        {
          id: 'owner-dm-thread',
          title: 'Owner DM',
          updatedAt: TIMESTAMP,
          source: 'telegram',
          channelUserId: 'tg-owner',
          channelUserRole: 'owner'
        }
      ]
    })

    useAppStore.getState().applyServerEvent({
      type: 'run.completed',
      eventId: 'event-owner-dm-channel-run-completed',
      timestamp: '2026-03-15T00:00:02.000Z',
      threadId: 'owner-dm-thread',
      runId: 'run-owner-dm-channel',
      runTrigger: 'channel'
    })

    assert.deepEqual(notifications, [])
    assert.deepEqual(useAppStore.getState().queuedToasts, [])
  } finally {
    restoreDocument()
    restoreWindow()
  }
})

test('applyServerEvent still notifies for owner DM runs started locally', () => {
  resetStore()

  const notifications: Array<{ title: string; body?: string }> = []
  const restoreWindow = withWindowApiMock({
    showNotification: (input) => {
      notifications.push(input)
    }
  })
  const restoreDocument = withDocumentFocusMock({ hidden: true, hasFocus: false })

  try {
    useAppStore.setState({
      activeThreadId: 'local-thread',
      config: {
        enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
        general: {
          notifyRunCompleted: true
        },
        providers: []
      },
      messages: {
        'owner-dm-thread': [
          {
            id: 'assistant-1',
            threadId: 'owner-dm-thread',
            role: 'assistant',
            content: 'Done locally',
            status: 'completed',
            createdAt: TIMESTAMP
          }
        ]
      },
      threads: [
        { id: 'local-thread', title: 'Local', updatedAt: TIMESTAMP },
        {
          id: 'owner-dm-thread',
          title: 'Owner DM',
          updatedAt: TIMESTAMP,
          source: 'telegram',
          channelUserId: 'tg-owner',
          channelUserRole: 'owner'
        }
      ]
    })

    useAppStore.getState().applyServerEvent({
      type: 'run.completed',
      eventId: 'event-owner-dm-local-run-completed',
      timestamp: '2026-03-15T00:00:02.000Z',
      threadId: 'owner-dm-thread',
      runId: 'run-owner-dm-local',
      runTrigger: 'local'
    })

    assert.deepEqual(notifications, [{ title: 'Owner DM', body: 'Done locally' }])
    assert.equal(useAppStore.getState().queuedToasts.length, 1)
  } finally {
    restoreDocument()
    restoreWindow()
  }
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

test('applyServerEvent keeps same-timestamp tool calls stable across recovery-style updates', () => {
  resetStore()

  useAppStore.getState().applyServerEvent({
    type: 'tool.updated',
    eventId: 'event-tool-1-started',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    toolCall: {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read',
      status: 'running',
      inputSummary: 'first',
      startedAt: TIMESTAMP,
      stepIndex: 1
    }
  })
  useAppStore.getState().applyServerEvent({
    type: 'tool.updated',
    eventId: 'event-tool-2-started',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    toolCall: {
      id: 'tool-2',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'write',
      status: 'running',
      inputSummary: 'second',
      startedAt: TIMESTAMP,
      stepIndex: 2
    }
  })
  useAppStore.getState().applyServerEvent({
    type: 'tool.updated',
    eventId: 'event-tool-1-recovered',
    timestamp: '2026-03-15T00:00:01.000Z',
    threadId: 'thread-1',
    runId: 'run-1',
    toolCall: {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'read',
      status: 'failed',
      inputSummary: 'first',
      outputSummary: 'Tool execution was interrupted before completion.',
      startedAt: TIMESTAMP,
      finishedAt: '2026-03-15T00:00:01.000Z',
      stepIndex: 1
    }
  })

  assert.deepEqual(
    useAppStore.getState().toolCalls['thread-1']?.map((toolCall) => toolCall.id),
    ['tool-1', 'tool-2']
  )
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
