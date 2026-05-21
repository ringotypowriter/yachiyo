import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ENABLED_TOOL_NAMES } from '../../../../shared/yachiyo/protocol.ts'
import {
  DEFAULT_SIDEBAR_FILTER,
  DEFAULT_SETTINGS,
  getComposerReasoningEffort,
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
    activeEssentialId: null,
    activeRunId: null,
    activeRunIdsByThread: {},
    activeRequestMessageId: null,
    activeRequestMessageIdsByThread: {},
    activeRunThreadId: null,
    activeThreadId: null,
    archivedThreads: [],
    composerDrafts: {},
    globalProcessingTasks: [],
    reasoningEffortByThread: {},
    config: null,
    connectionStatus: 'connected',
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    runMode: 'auto',
    toolModeByThread: {},
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
    retryInfoByThread: {},
    messages: {},
    pendingAssistantMessages: {},
    pendingAcpBinding: null,
    pendingModelOverride: null,
    pendingSteerMessages: {},
    pendingWorkspacePath: null,
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
    todoListsByThread: {},
    planDocumentsByThread: {},
    toolCalls: {}
  })
}

type YachiyoApiMock = Partial<Window['api']['yachiyo']>

type MockedAnimationFrameWindow = Window & {
  __flushNextAnimationFrame: () => void
}

function getMockedAnimationFrameWindow(): MockedAnimationFrameWindow {
  return globalThis.window as unknown as MockedAnimationFrameWindow
}

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

function installAnimationFrameMock(): void {
  const callbacks: FrameRequestCallback[] = []
  const win = getMockedAnimationFrameWindow()
  win.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callbacks.push(callback)
    return callbacks.length
  }
  win.__flushNextAnimationFrame = (): void => {
    const callback = callbacks.shift()
    assert.ok(callback, 'expected a queued animation frame')
    callback(0)
  }
}

test('rejectPlanDocument only marks the plan rejected', async () => {
  resetStore()

  const sendChatInputs: unknown[] = []
  const restoreWindow = withWindowApiMock({
    sendChat: async (input) => {
      sendChatInputs.push(input)
      throw new Error('reject should not send chat')
    }
  })

  try {
    useAppStore.setState({
      planDocumentsByThread: {
        'thread-plan': {
          path: '.yachiyo/plan-abcxyz.md',
          content: '# Execution Plan',
          updatedAt: TIMESTAMP,
          decision: 'pending'
        }
      }
    })

    await useAppStore.getState().rejectPlanDocument('thread-plan')

    assert.equal(useAppStore.getState().planDocumentsByThread['thread-plan']?.decision, 'rejected')
    assert.deepEqual(sendChatInputs, [])
  } finally {
    restoreWindow()
  }
})

test('sendMessage with a pending plan sends visible revision feedback in plan mode', async () => {
  resetStore()

  const sendChatInputs: Array<{ content?: string; hidden?: boolean; runMode?: string }> = []
  const restoreWindow = withWindowApiMock({
    sendChat: async (input) => {
      sendChatInputs.push(input)
      return {
        kind: 'run-started',
        runId: 'run-revise',
        thread: {
          id: 'thread-plan',
          title: 'Plan thread',
          updatedAt: TIMESTAMP
        },
        userMessage: {
          id: 'user-revise',
          threadId: 'thread-plan',
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
      activeThreadId: 'thread-plan',
      runMode: 'auto',
      threads: [{ id: 'thread-plan', title: 'Plan thread', updatedAt: TIMESTAMP }],
      composerDrafts: {
        'thread-plan': {
          text: 'Please tighten validation steps.',
          images: [],
          files: [],
          enabledSkillNames: null
        }
      },
      planDocumentsByThread: {
        'thread-plan': {
          path: '.yachiyo/plan-abcxyz.md',
          content: '# Execution Plan',
          updatedAt: TIMESTAMP,
          decision: 'pending'
        }
      }
    })

    const sent = await useAppStore.getState().sendMessage()

    assert.equal(sent, true)
    assert.equal(sendChatInputs.length, 1)
    assert.equal(sendChatInputs[0]?.content, 'Please tighten validation steps.')
    assert.equal(sendChatInputs[0]?.hidden, undefined)
    assert.equal(sendChatInputs[0]?.runMode, 'plan')
    assert.equal(useAppStore.getState().planDocumentsByThread['thread-plan']?.decision, 'rejected')
    assert.equal(useAppStore.getState().composerDrafts['thread-plan'], undefined)
  } finally {
    restoreWindow()
  }
})

test('acceptPlanDocument switches the handoff execution thread composer to auto mode', async () => {
  resetStore()

  const sendChatInputs: Array<{ content?: string; enabledTools?: string[]; runMode?: string }> = []
  const restoreWindow = withWindowApiMock({
    acceptThreadPlanDocument: async ({ threadId, mode }) => {
      assert.equal(threadId, 'thread-plan')
      assert.equal(mode, 'handoff')
      return {
        kind: 'run-started',
        runId: 'run-execute',
        thread: {
          id: 'thread-execute',
          title: 'Execution thread',
          updatedAt: TIMESTAMP,
          enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
          runMode: 'auto'
        },
        userMessage: {
          id: 'user-execute',
          threadId: 'thread-execute',
          role: 'user',
          content: 'Execute the accepted plan.',
          status: 'completed',
          createdAt: TIMESTAMP
        }
      }
    },
    sendChat: async (input) => {
      sendChatInputs.push(input)
      return {
        kind: 'run-started',
        runId: 'run-follow-up',
        thread: {
          id: 'thread-execute',
          title: 'Execution thread',
          updatedAt: TIMESTAMP,
          enabledTools: input.enabledTools,
          runMode: input.runMode
        },
        userMessage: {
          id: 'user-follow-up',
          threadId: 'thread-execute',
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
      activeThreadId: 'thread-plan',
      runMode: 'plan',
      enabledTools: [],
      toolModeByThread: {
        'thread-plan': { enabledTools: [], runMode: 'plan' }
      },
      threads: [{ id: 'thread-plan', title: 'Plan thread', updatedAt: TIMESTAMP }],
      planDocumentsByThread: {
        'thread-plan': {
          path: '.yachiyo/plan-abcxyz.md',
          content: '# Execution Plan',
          updatedAt: TIMESTAMP,
          decision: 'pending'
        }
      }
    })

    await useAppStore.getState().acceptPlanDocument('thread-plan', 'handoff')

    const state = useAppStore.getState()
    assert.equal(state.activeThreadId, 'thread-execute')
    assert.equal(state.runMode, 'auto')
    assert.deepEqual(state.enabledTools, DEFAULT_ENABLED_TOOL_NAMES)
    assert.deepEqual(state.toolModeByThread['thread-execute'], {
      enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
      runMode: 'auto'
    })

    useAppStore.setState({
      composerDrafts: {
        'thread-execute': {
          text: 'Continue with step one.',
          images: [],
          files: [],
          enabledSkillNames: null
        }
      }
    })

    const sent = await useAppStore.getState().sendMessage()

    assert.equal(sent, true)
    assert.equal(sendChatInputs.length, 1)
    assert.equal(sendChatInputs[0]?.content, 'Continue with step one.')
    assert.equal(sendChatInputs[0]?.runMode, 'auto')
    assert.deepEqual(sendChatInputs[0]?.enabledTools, DEFAULT_ENABLED_TOOL_NAMES)
  } finally {
    restoreWindow()
  }
})

test('acceptPlanDocument keeps direct execution in the source thread and switches composer to auto mode', async () => {
  resetStore()

  const sendChatInputs: Array<{ content?: string; enabledTools?: string[]; runMode?: string }> = []
  const restoreWindow = withWindowApiMock({
    acceptThreadPlanDocument: async ({ threadId, mode }) => {
      assert.equal(threadId, 'thread-plan')
      assert.equal(mode, 'direct')
      return {
        kind: 'run-started',
        runId: 'run-execute',
        thread: {
          id: 'thread-plan',
          title: 'Plan thread',
          updatedAt: TIMESTAMP,
          enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
          runMode: 'auto'
        },
        userMessage: {
          id: 'user-execute',
          threadId: 'thread-plan',
          role: 'user',
          content: 'Execute the accepted plan.',
          status: 'completed',
          createdAt: TIMESTAMP
        }
      }
    },
    sendChat: async (input) => {
      sendChatInputs.push(input)
      return {
        kind: 'run-started',
        runId: 'run-follow-up',
        thread: {
          id: 'thread-plan',
          title: 'Plan thread',
          updatedAt: TIMESTAMP,
          enabledTools: input.enabledTools,
          runMode: input.runMode
        },
        userMessage: {
          id: 'user-follow-up',
          threadId: 'thread-plan',
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
      activeThreadId: 'thread-plan',
      runMode: 'plan',
      enabledTools: [],
      toolModeByThread: {
        'thread-plan': { enabledTools: [], runMode: 'plan' }
      },
      threads: [{ id: 'thread-plan', title: 'Plan thread', updatedAt: TIMESTAMP }],
      planDocumentsByThread: {
        'thread-plan': {
          path: '.yachiyo/plan-abcxyz.md',
          content: '# Execution Plan',
          updatedAt: TIMESTAMP,
          decision: 'pending'
        }
      }
    })

    await useAppStore.getState().acceptPlanDocument('thread-plan', 'direct')

    const state = useAppStore.getState()
    assert.equal(state.activeThreadId, 'thread-plan')
    assert.equal(state.runMode, 'auto')
    assert.deepEqual(state.enabledTools, DEFAULT_ENABLED_TOOL_NAMES)
    assert.deepEqual(state.toolModeByThread['thread-plan'], {
      enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
      runMode: 'auto'
    })

    useAppStore.setState({
      composerDrafts: {
        'thread-plan': {
          text: 'Continue with step one.',
          images: [],
          files: [],
          enabledSkillNames: null
        }
      }
    })

    const sent = await useAppStore.getState().sendMessage()

    assert.equal(sent, true)
    assert.equal(sendChatInputs.length, 1)
    assert.equal(sendChatInputs[0]?.content, 'Continue with step one.')
    assert.equal(sendChatInputs[0]?.runMode, 'auto')
    assert.deepEqual(sendChatInputs[0]?.enabledTools, DEFAULT_ENABLED_TOOL_NAMES)
  } finally {
    restoreWindow()
  }
})

test('deleteThread shows global processing before invoking the database action', async () => {
  resetStore()

  let deleteCalled = false
  const deleteController: { resolve: (() => void) | null } = { resolve: null }
  const restoreWindow = withWindowApiMock({
    deleteThread: async ({ threadId }) => {
      deleteCalled = true
      assert.equal(threadId, 'thread-1')
      await new Promise<void>((resolve) => {
        deleteController.resolve = resolve
      })
    }
  })
  installAnimationFrameMock()

  try {
    const deletePromise = useAppStore.getState().deleteThread('thread-1')

    let processingTasks = useAppStore.getState().globalProcessingTasks
    assert.equal(processingTasks.length, 1)
    assert.equal(processingTasks[0]?.label, 'Deleting thread...')
    assert.equal(deleteCalled, false)

    getMockedAnimationFrameWindow().__flushNextAnimationFrame()
    await Promise.resolve()
    assert.equal(deleteCalled, false)

    getMockedAnimationFrameWindow().__flushNextAnimationFrame()
    await Promise.resolve()
    assert.equal(deleteCalled, true)
    processingTasks = useAppStore.getState().globalProcessingTasks
    assert.equal(processingTasks.length, 1)
    assert.equal(processingTasks[0]?.label, 'Deleting thread...')

    const completeDelete = deleteController.resolve
    assert.ok(completeDelete, 'delete promise should be pending until resolved')
    completeDelete()
    await deletePromise
    assert.deepEqual(useAppStore.getState().globalProcessingTasks, [])
  } finally {
    restoreWindow()
  }
})

test('deleteFolder clears global processing when discard fails', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    deleteFolder: async ({ folderId }) => {
      assert.equal(folderId, 'folder-1')
      throw new Error('discard failed')
    }
  })
  installAnimationFrameMock()

  try {
    const deletePromise = useAppStore.getState().deleteFolder('folder-1')

    const processingTasks = useAppStore.getState().globalProcessingTasks
    assert.equal(processingTasks.length, 1)
    assert.equal(processingTasks[0]?.label, 'Discarding folder...')

    getMockedAnimationFrameWindow().__flushNextAnimationFrame()
    getMockedAnimationFrameWindow().__flushNextAnimationFrame()
    await assert.rejects(deletePromise, /discard failed/)
    assert.deepEqual(useAppStore.getState().globalProcessingTasks, [])
  } finally {
    restoreWindow()
  }
})

test('initialize hydrates the active thread run history after bootstrap', async () => {
  resetStore()

  let loadThreadDataCalls = 0
  const restoreWindow = withWindowApiMock({
    bootstrap: async () => ({
      threads: [
        {
          id: 'thread-1',
          title: 'Thread 1',
          reasoningEffort: 'high',
          todoItems: [
            { id: 'todo-1', content: 'Inspect the flow', status: 'completed' },
            { id: 'todo-2', content: 'Persist the widget', status: 'in_progress' }
          ],
          updatedAt: TIMESTAMP
        },
        {
          id: 'thread-2',
          title: 'Thread 2',
          updatedAt: '2026-03-15T00:01:00.000Z'
        }
      ],
      archivedThreads: [],
      folders: [],
      messagesByThread: {
        'thread-1': [
          {
            id: 'user-older',
            threadId: 'thread-1',
            role: 'user',
            content: 'Older request',
            status: 'completed',
            createdAt: '2026-03-15T00:00:00.000Z'
          },
          {
            id: 'user-latest',
            threadId: 'thread-1',
            role: 'user',
            content: 'Latest request',
            status: 'completed',
            createdAt: '2026-03-15T00:05:00.000Z'
          }
        ]
      },
      toolCallsByThread: {
        'thread-1': [],
        'thread-2': []
      },
      latestRunsByThread: {
        'thread-1': {
          id: 'run-latest',
          threadId: 'thread-1',
          status: 'completed',
          createdAt: '2026-03-15T00:05:00.000Z',
          completedAt: '2026-03-15T00:05:10.000Z',
          requestMessageId: 'user-latest'
        },
        'thread-2': {
          id: 'run-cancelled',
          threadId: 'thread-2',
          status: 'cancelled',
          createdAt: '2026-03-15T00:01:00.000Z',
          completedAt: '2026-03-15T00:01:10.000Z',
          promptTokens: 30_000,
          completionTokens: 120
        }
      },
      recoveredInterruptedSaveThreadIds: [],
      config: {
        enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
        providers: []
      },
      settings: READY_SETTINGS
    }),
    subscribe: () => () => undefined,
    loadThreadData: async ({ threadId }) => {
      loadThreadDataCalls += 1
      assert.equal(threadId, 'thread-1')
      return {
        messages: [],
        toolCalls: [],
        runs: [
          {
            id: 'run-older',
            threadId: 'thread-1',
            status: 'completed',
            createdAt: '2026-03-15T00:00:00.000Z',
            completedAt: '2026-03-15T00:00:10.000Z',
            requestMessageId: 'user-older',
            snapshotFileCount: 3,
            workspacePath: '/tmp/external-workspace'
          },
          {
            id: 'run-latest',
            threadId: 'thread-1',
            status: 'completed',
            createdAt: '2026-03-15T00:05:00.000Z',
            completedAt: '2026-03-15T00:05:10.000Z',
            requestMessageId: 'user-latest'
          }
        ]
      }
    }
  })

  try {
    await useAppStore.getState().initialize()

    const state = useAppStore.getState()
    assert.equal(loadThreadDataCalls, 1)
    assert.equal(state.activeThreadId, 'thread-1')
    assert.equal(state.reasoningEffortByThread['thread-1'], 'high')
    assert.equal(getComposerReasoningEffort(state, 'thread-1'), 'high')
    assert.deepEqual(state.todoListsByThread['thread-1'], {
      items: [
        { id: 'todo-1', content: 'Inspect the flow', status: 'completed' },
        { id: 'todo-2', content: 'Persist the widget', status: 'in_progress' }
      ],
      updatedAt: TIMESTAMP
    })
    assert.deepEqual(state.runsByThread['thread-1'], [
      {
        id: 'run-older',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-15T00:00:00.000Z',
        completedAt: '2026-03-15T00:00:10.000Z',
        requestMessageId: 'user-older',
        snapshotFileCount: 3,
        workspacePath: '/tmp/external-workspace'
      },
      {
        id: 'run-latest',
        threadId: 'thread-1',
        status: 'completed',
        createdAt: '2026-03-15T00:05:00.000Z',
        completedAt: '2026-03-15T00:05:10.000Z',
        requestMessageId: 'user-latest'
      }
    ])
    assert.equal(state.latestRunsByThread['thread-2']?.status, 'cancelled')
    assert.equal(state.latestRunsByThread['thread-2']?.promptTokens, 30_000)
    assert.equal(state.latestRunsByThread['thread-2']?.completionTokens, 120)
  } finally {
    restoreWindow()
  }
})

test('initialize loads the active thread messages after lightweight bootstrap', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    bootstrap: async () => ({
      threads: [{ id: 'thread-1', title: 'Thread 1', updatedAt: TIMESTAMP }],
      archivedThreads: [],
      folders: [],
      messagesByThread: {},
      toolCallsByThread: {},
      latestRunsByThread: {},
      recoveredInterruptedSaveThreadIds: [],
      config: {
        enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
        providers: []
      },
      settings: READY_SETTINGS
    }),
    subscribe: () => () => undefined,
    loadThreadData: async ({ threadId }) => {
      assert.equal(threadId, 'thread-1')
      return {
        messages: [
          {
            id: 'message-1',
            threadId,
            role: 'user',
            content: 'Loaded on demand',
            status: 'completed',
            createdAt: TIMESTAMP
          }
        ],
        toolCalls: [
          {
            id: 'tool-call-1',
            threadId,
            toolName: 'read',
            status: 'completed',
            inputSummary: 'read file',
            startedAt: TIMESTAMP
          }
        ],
        runs: []
      }
    }
  })

  try {
    await useAppStore.getState().initialize()

    const state = useAppStore.getState()
    assert.equal(state.messages['thread-1']?.[0]?.content, 'Loaded on demand')
    assert.equal(state.toolCalls['thread-1']?.[0]?.id, 'tool-call-1')
  } finally {
    restoreWindow()
  }
})

test('setActiveThread keeps only the recent loaded thread data in memory', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    loadThreadData: async ({ threadId }) => ({
      messages: [
        {
          id: `${threadId}-message`,
          threadId,
          role: 'user',
          content: threadId,
          status: 'completed',
          createdAt: TIMESTAMP
        }
      ],
      toolCalls: [],
      runs: []
    })
  })

  useAppStore.setState({
    activeThreadId: 'thread-6',
    messages: {
      'thread-1': [],
      'thread-2': [],
      'thread-3': [],
      'thread-4': [],
      'thread-5': [],
      'thread-6': []
    },
    toolCalls: {
      'thread-1': [],
      'thread-2': [],
      'thread-3': [],
      'thread-4': [],
      'thread-5': [],
      'thread-6': []
    }
  })

  try {
    useAppStore.getState().setActiveThread('thread-7')
    await new Promise<void>((resolve) => setImmediate(resolve))

    const state = useAppStore.getState()
    assert.equal(Object.keys(state.messages).length <= 6, true)
    assert.equal(Object.keys(state.toolCalls).length <= 6, true)
    assert.equal(state.messages['thread-1'], undefined)
    assert.equal(state.messages['thread-7']?.[0]?.content, 'thread-7')
  } finally {
    restoreWindow()
  }
})

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

test('applyServerEvent keeps cancelled run token counts for run history', () => {
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
    type: 'run.usage.updated',
    eventId: 'event-run-usage-updated',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    promptTokens: 30_000,
    completionTokens: 120
  })
  useAppStore.getState().applyServerEvent({
    type: 'run.cancelled',
    eventId: 'event-run-cancelled',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1'
  })

  const latestRun = useAppStore.getState().latestRunsByThread['thread-1']

  assert.equal(latestRun?.status, 'cancelled')
  assert.equal(latestRun?.promptTokens, 30_000)
  assert.equal(latestRun?.completionTokens, 120)
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

test('applyServerEvent clears retry info when a recovered run updates a tool', () => {
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
  useAppStore.getState().applyServerEvent({
    type: 'tool.updated',
    eventId: 'event-tool-updated',
    timestamp: '2026-03-15T00:00:01.000Z',
    threadId: 'thread-1',
    runId: 'run-1',
    toolCall: {
      id: 'tool-1',
      runId: 'run-1',
      threadId: 'thread-1',
      toolName: 'grep',
      status: 'running',
      inputSummary: 'pattern',
      startedAt: '2026-03-15T00:00:01.000Z'
    }
  })

  const state = useAppStore.getState()

  assert.deepEqual(state.retryInfoByThread, {})
  assert.equal(state.toolCalls['thread-1']?.[0]?.status, 'running')
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

test('applyServerEvent marks completed runs in inactive threads as just done', () => {
  resetStore()
  useAppStore.setState({
    activeThreadId: 'thread-active',
    config: {
      enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
      general: {
        notifyRunCompleted: false
      },
      providers: []
    },
    threads: [
      {
        id: 'thread-active',
        title: 'Active thread',
        updatedAt: TIMESTAMP
      },
      {
        id: 'thread-idle',
        title: 'Idle thread',
        updatedAt: TIMESTAMP
      }
    ]
  })

  useAppStore.getState().applyServerEvent({
    type: 'run.created',
    eventId: 'event-run-created',
    timestamp: TIMESTAMP,
    threadId: 'thread-idle',
    runId: 'run-1'
  })
  useAppStore.getState().applyServerEvent({
    type: 'run.completed',
    eventId: 'event-run-completed',
    timestamp: '2026-03-15T00:00:05.000Z',
    threadId: 'thread-idle',
    runId: 'run-1'
  })

  assert.deepEqual(useAppStore.getState().justDoneRunIdsByThread, {
    'thread-idle': 'run-1'
  })
})

test('applyServerEvent does not mark the currently open thread as just done', () => {
  resetStore()
  useAppStore.setState({
    activeThreadId: 'thread-active',
    config: {
      enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
      general: {
        notifyRunCompleted: false
      },
      providers: []
    },
    threads: [
      {
        id: 'thread-active',
        title: 'Active thread',
        updatedAt: TIMESTAMP
      }
    ]
  })

  useAppStore.getState().applyServerEvent({
    type: 'run.created',
    eventId: 'event-run-created',
    timestamp: TIMESTAMP,
    threadId: 'thread-active',
    runId: 'run-1'
  })
  useAppStore.getState().applyServerEvent({
    type: 'run.completed',
    eventId: 'event-run-completed',
    timestamp: '2026-03-15T00:00:05.000Z',
    threadId: 'thread-active',
    runId: 'run-1'
  })

  assert.deepEqual(useAppStore.getState().justDoneRunIdsByThread, {})
})

test('setActiveThread clears the just done run marker after the user opens the thread', () => {
  resetStore()
  const restoreWindow = withWindowApiMock({
    loadThreadData: async () => ({
      messages: [],
      toolCalls: [],
      runs: []
    })
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-active',
      justDoneRunIdsByThread: {
        'thread-idle': 'run-1'
      }
    })

    useAppStore.getState().setActiveThread('thread-idle')

    assert.deepEqual(useAppStore.getState().justDoneRunIdsByThread, {})
  } finally {
    restoreWindow()
  }
})

test('applyServerEvent ignores stale completion events after the next run starts', () => {
  resetStore()
  useAppStore.setState({ activeThreadId: 'thread-1' })

  useAppStore.getState().applyServerEvent({
    type: 'run.created',
    eventId: 'event-run-created-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    requestMessageId: 'user-1'
  })
  useAppStore.getState().applyServerEvent({
    type: 'message.started',
    eventId: 'event-message-started-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    messageId: 'assistant-1',
    parentMessageId: 'user-1'
  })
  useAppStore.getState().applyServerEvent({
    type: 'message.delta',
    eventId: 'event-message-delta-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    messageId: 'assistant-1',
    delta: 'Checking the workspace.'
  })
  useAppStore.getState().applyServerEvent({
    type: 'run.created',
    eventId: 'event-run-created-2',
    timestamp: '2026-03-15T00:00:01.000Z',
    threadId: 'thread-1',
    runId: 'run-2',
    requestMessageId: 'user-2'
  })
  useAppStore.getState().applyServerEvent({
    type: 'run.completed',
    eventId: 'event-run-completed-1',
    timestamp: '2026-03-15T00:00:02.000Z',
    threadId: 'thread-1',
    runId: 'run-1'
  })

  const state = useAppStore.getState()

  assert.equal(state.activeRunId, 'run-2')
  assert.equal(state.activeRunIdsByThread['thread-1'], 'run-2')
  assert.equal(state.activeRequestMessageId, 'user-2')
  assert.equal(state.activeRequestMessageIdsByThread['thread-1'], 'user-2')
  assert.equal(state.activeRunThreadId, 'thread-1')
  assert.equal(state.runPhase, 'preparing')
  assert.equal(state.runPhasesByThread['thread-1'], 'preparing')
  assert.equal(state.runStatus, 'running')
  assert.equal(state.runStatusesByThread['thread-1'], 'running')
  assert.equal(state.latestRunsByThread['thread-1']?.id, 'run-1')
  assert.equal(state.latestRunsByThread['thread-1']?.status, 'completed')
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
