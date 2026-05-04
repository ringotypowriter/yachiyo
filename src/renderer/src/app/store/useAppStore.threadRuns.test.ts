import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ENABLED_TOOL_NAMES } from '../../../../shared/yachiyo/protocol.ts'
import { DEFAULT_SIDEBAR_FILTER, DEFAULT_SETTINGS, useAppStore } from './useAppStore.ts'

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

test('setThreadWorkspace updates only the matching thread collection', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    updateThreadWorkspace: async ({ threadId, workspacePath }) => ({
      id: threadId,
      title: threadId === 'thread-1' ? 'Local thread' : 'External thread',
      updatedAt: '2026-03-15T00:00:02.000Z',
      ...(workspacePath ? { workspacePath } : {}),
      source: threadId === 'thread-1' ? 'local' : 'discord'
    })
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      threads: [{ id: 'thread-1', title: 'Local thread', updatedAt: TIMESTAMP }],
      externalThreads: [
        {
          id: 'external-thread',
          title: 'External thread',
          updatedAt: TIMESTAMP,
          source: 'discord'
        }
      ]
    })

    await useAppStore.getState().setThreadWorkspace('/tmp/local-workspace', 'thread-1')

    let state = useAppStore.getState()
    assert.equal(
      state.threads.find((thread) => thread.id === 'thread-1')?.workspacePath,
      '/tmp/local-workspace'
    )
    assert.deepEqual(
      state.externalThreads.map((thread) => thread.id),
      ['external-thread']
    )

    await useAppStore.getState().setThreadWorkspace('/tmp/external-workspace', 'external-thread')

    state = useAppStore.getState()
    assert.equal(
      state.externalThreads.find((thread) => thread.id === 'external-thread')?.workspacePath,
      '/tmp/external-workspace'
    )
    assert.deepEqual(
      state.threads.map((thread) => thread.id),
      ['thread-1']
    )
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

  const calls: Array<{
    content: string
    enabledTools?: string[]
    reasoningEffort?: string
    threadId: string
  }> = []
  const restoreWindow = withWindowApiMock({
    sendChat: async (input) => {
      calls.push({
        content: input.content,
        enabledTools: input.enabledTools,
        reasoningEffort: input.reasoningEffort,
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
      reasoningEffortByThread: {
        'thread-1': 'high'
      },
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
        reasoningEffort: 'high',
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

test('revertPendingSteer restores the queued steer skill override into the composer draft', async () => {
  resetStore()

  const withdrawCalls: string[] = []
  const restoreWindow = withWindowApiMock({
    withdrawPendingSteer: async ({ threadId }) => {
      withdrawCalls.push(threadId)
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      composerDrafts: {
        'thread-1': {
          text: '',
          images: [],
          files: [],
          enabledSkillNames: null
        }
      },
      pendingSteerMessages: {
        'thread-1': {
          segments: [
            {
              content: 'Queued steer',
              enabledSkillNames: ['workspace-refactor']
            }
          ],
          content: 'Queued steer',
          createdAt: TIMESTAMP
        }
      }
    })

    await useAppStore.getState().revertPendingSteer()

    const state = useAppStore.getState()
    assert.deepEqual(withdrawCalls, ['thread-1'])
    assert.equal(state.pendingSteerMessages['thread-1'], undefined)
    assert.equal(state.composerDrafts['thread-1']?.text, 'Queued steer')
    assert.deepEqual(state.composerDrafts['thread-1']?.enabledSkillNames, ['workspace-refactor'])
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
    reasoningEffort?: string
    threadId: string
  }> = []
  const restoreWindow = withWindowApiMock({
    retryMessage: async (input) => {
      calls.push({
        enabledSkillNames: input.enabledSkillNames,
        enabledTools: input.enabledTools,
        messageId: input.messageId,
        reasoningEffort: input.reasoningEffort,
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
      reasoningEffortByThread: {
        'thread-1': 'high'
      },
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
        reasoningEffort: 'high',
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
