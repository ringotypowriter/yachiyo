import type { YachiyoPreloadYachiyoApi } from '../../../../preload/index.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ENABLED_TOOL_NAMES } from '../../../../shared/yachiyo/protocol.ts'
import {
  DEFAULT_SIDEBAR_FILTER,
  DEFAULT_SETTINGS,
  getEffectiveModel,
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

type YachiyoApiMock = Partial<YachiyoPreloadYachiyoApi>

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

test('createBranch clears usage data for the destination thread', async () => {
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
      latestRunsByThread: {
        'thread-1': {
          id: 'run-source',
          threadId: 'thread-1',
          status: 'completed',
          createdAt: TIMESTAMP,
          completedAt: TIMESTAMP,
          promptTokens: 30_000,
          completionTokens: 120
        },
        'thread-2': {
          id: 'run-stale',
          threadId: 'thread-2',
          status: 'completed',
          createdAt: TIMESTAMP,
          completedAt: TIMESTAMP,
          promptTokens: 42_000,
          completionTokens: 240
        }
      },
      runsByThread: {
        'thread-2': [
          {
            id: 'run-stale',
            threadId: 'thread-2',
            status: 'completed',
            createdAt: TIMESTAMP,
            completedAt: TIMESTAMP,
            promptTokens: 42_000,
            completionTokens: 240
          }
        ]
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
    assert.equal(state.latestRunsByThread['thread-1']?.promptTokens, 30_000)
    assert.equal(state.latestRunsByThread['thread-2'], undefined)
    assert.deepEqual(state.runsByThread['thread-2'], [])
  } finally {
    restoreWindow()
  }
})

test('compactThreadToAnotherThread switches into the destination thread and starts a run', async () => {
  resetStore()

  const calls: Array<{ reasoningEffort?: string; threadId: string }> = []
  const restoreWindow = withWindowApiMock({
    compactThreadToAnotherThread: async (input) => {
      calls.push({
        reasoningEffort: input.reasoningEffort,
        threadId: input.threadId
      })

      return {
        runId: 'run-compact-1',
        sourceThreadId: input.threadId,
        thread: {
          id: 'thread-2',
          title: 'New Chat',
          updatedAt: TIMESTAMP
        }
      }
    }
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
      reasoningEffortByThread: {
        'thread-1': 'high'
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
    assert.deepEqual(calls, [{ reasoningEffort: 'high', threadId: 'thread-1' }])
    assert.equal(state.activeThreadId, 'thread-2')
    assert.equal(state.activeRunId, 'run-compact-1')
    assert.equal(state.activeRunThreadId, 'thread-2')
    assert.equal(state.activeRequestMessageId, null)
    assert.equal(state.runPhase, 'preparing')
    assert.equal(state.runStatus, 'running')
    assert.equal(state.composerDrafts['thread-1']?.text, 'Keep me here too')
    assert.equal(state.composerDrafts['thread-2'], undefined)
    assert.equal(state.reasoningEffortByThread['thread-1'], 'high')
    assert.equal(state.reasoningEffortByThread['thread-2'], 'high')
  } finally {
    restoreWindow()
  }
})

test('compactThreadToAnotherThread blocks owner DM threads before IPC', async () => {
  resetStore()

  let compactCalls = 0
  const restoreWindow = withWindowApiMock({
    compactThreadToAnotherThread: async () => {
      compactCalls += 1
      throw new Error('compact should not be called')
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'owner-dm-thread',
      threads: [
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

    await assert.rejects(useAppStore.getState().compactThreadToAnotherThread())

    const state = useAppStore.getState()
    assert.equal(compactCalls, 0)
    assert.equal(typeof state.lastError, 'string')
  } finally {
    restoreWindow()
  }
})

test('compactThreadToAnotherThread allows took-over owner DM threads', async () => {
  resetStore()

  const calls: string[] = []
  const restoreWindow = withWindowApiMock({
    compactThreadToAnotherThread: async (input) => {
      calls.push(input.threadId)
      return {
        runId: 'run-compact-owner-dm',
        sourceThreadId: input.threadId,
        thread: {
          id: 'handoff-thread',
          title: 'New Chat',
          updatedAt: TIMESTAMP
        }
      }
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'owner-dm-thread',
      threads: [
        {
          id: 'owner-dm-thread',
          title: 'Owner DM',
          updatedAt: TIMESTAMP,
          channelUserId: 'tg-owner',
          channelUserRole: 'owner'
        }
      ]
    })

    await useAppStore.getState().compactThreadToAnotherThread()

    const state = useAppStore.getState()
    assert.deepEqual(calls, ['owner-dm-thread'])
    assert.equal(state.activeThreadId, 'handoff-thread')
    assert.equal(state.activeRunId, 'run-compact-owner-dm')
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

test('createNewThreadFromEssential preserves the staged new-chat draft', () => {
  resetStore()

  useAppStore.setState({
    activeEssentialId: 'essential-a',
    composerDrafts: {
      __new__: {
        text: 'Keep this while I switch',
        images: [],
        files: [],
        enabledSkillNames: null
      }
    },
    config: {
      providers: [],
      essentials: [
        {
          id: 'essential-a',
          icon: 'A',
          iconType: 'emoji',
          label: 'Alpha',
          order: 0
        },
        {
          id: 'essential-b',
          icon: 'B',
          iconType: 'emoji',
          label: 'Beta',
          workspacePath: '/tmp/beta',
          modelOverride: { providerName: 'work', model: 'gpt-5' },
          order: 1
        }
      ]
    }
  })

  useAppStore.getState().createNewThreadFromEssential('essential-b')

  const state = useAppStore.getState()
  assert.equal(state.activeThreadId, null)
  assert.equal(state.activeEssentialId, 'essential-b')
  assert.equal(state.pendingWorkspacePath, '/tmp/beta')
  assert.deepEqual(state.pendingModelOverride, { providerName: 'work', model: 'gpt-5' })
  assert.equal(state.composerDrafts.__new__?.text, 'Keep this while I switch')
})

test('createNewThreadFromEssential moves an active blank new-chat draft into the staged draft', () => {
  resetStore()

  useAppStore.setState({
    activeThreadId: 'thread-1',
    composerDrafts: {
      'thread-1': {
        text: 'Bring this into the essential',
        images: [],
        files: [],
        enabledSkillNames: null
      }
    },
    config: {
      providers: [],
      essentials: [
        {
          id: 'essential-a',
          icon: 'A',
          iconType: 'emoji',
          label: 'Alpha',
          order: 0
        }
      ]
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

  useAppStore.getState().createNewThreadFromEssential('essential-a')

  const state = useAppStore.getState()
  assert.equal(state.activeThreadId, null)
  assert.equal(state.activeEssentialId, 'essential-a')
  assert.equal(state.composerDrafts['thread-1'], undefined)
  assert.equal(state.composerDrafts.__new__?.text, 'Bring this into the essential')
})

test('createNewThread moves the staged essential draft into the new normal chat', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    createThread: async () => ({
      id: 'thread-1',
      title: 'New Chat',
      updatedAt: TIMESTAMP
    })
  })

  try {
    useAppStore.setState({
      activeEssentialId: 'essential-a',
      composerDrafts: {
        __new__: {
          text: 'Use this in a normal chat',
          images: [],
          files: [],
          enabledSkillNames: null
        }
      },
      pendingModelOverride: { providerName: 'essential-provider', model: 'essential-model' },
      pendingWorkspacePath: '/tmp/essential-workspace'
    })

    await useAppStore.getState().createNewThread()

    const state = useAppStore.getState()
    assert.equal(state.activeThreadId, 'thread-1')
    assert.equal(state.activeEssentialId, null)
    assert.equal(state.pendingModelOverride, null)
    assert.equal(state.pendingWorkspacePath, null)
    assert.equal(state.composerDrafts.__new__, undefined)
    assert.equal(state.composerDrafts['thread-1']?.text, 'Use this in a normal chat')
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

test('createNewThread moves the staged new-chat draft into a reusable blank chat', async () => {
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
      composerDrafts: {
        __new__: {
          text: 'Carry this into the reusable chat',
          images: [],
          files: [],
          enabledSkillNames: null
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
    assert.equal(createThreadCallCount, 0)
    assert.equal(state.activeThreadId, 'thread-1')
    assert.equal(state.composerDrafts.__new__, undefined)
    assert.equal(state.composerDrafts['thread-1']?.text, 'Carry this into the reusable chat')
  } finally {
    restoreWindow()
  }
})

test('createNewThread moves the staged new-chat reasoning effort into a reusable blank chat', async () => {
  resetStore()

  let createThreadCallCount = 0
  const reasoningCalls: Array<{ threadId: string; reasoningEffort: string | null }> = []
  const restoreWindow = withWindowApiMock({
    createThread: async () => {
      createThreadCallCount += 1
      return {
        id: 'thread-2',
        title: 'New Chat',
        updatedAt: TIMESTAMP
      }
    },
    setThreadReasoningEffort: async (input) => {
      reasoningCalls.push(input)
      return {
        id: input.threadId,
        title: 'New Chat',
        reasoningEffort: input.reasoningEffort ?? undefined,
        updatedAt: TIMESTAMP
      }
    }
  })

  try {
    useAppStore.setState({
      composerDrafts: {
        __new__: {
          text: 'Carry this into the reusable chat',
          images: [],
          files: [],
          enabledSkillNames: null
        }
      },
      reasoningEffortByThread: {
        __new__: 'high'
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
    await new Promise((resolve) => setTimeout(resolve, 0))

    const state = useAppStore.getState()
    assert.equal(createThreadCallCount, 0)
    assert.deepEqual(reasoningCalls, [{ threadId: 'thread-1', reasoningEffort: 'high' }])
    assert.equal(state.activeThreadId, 'thread-1')
    assert.equal(state.reasoningEffortByThread.__new__, undefined)
    assert.equal(state.reasoningEffortByThread['thread-1'], 'high')
  } finally {
    restoreWindow()
  }
})

test('createNewThread moves the staged new-chat reasoning effort into a new chat', async () => {
  resetStore()

  const createThreadInputs: Array<{ reasoningEffort?: string }> = []
  const restoreWindow = withWindowApiMock({
    createThread: async (input) => {
      createThreadInputs.push(input ?? {})
      return {
        id: 'thread-2',
        title: 'New Chat',
        reasoningEffort: input?.reasoningEffort,
        updatedAt: TIMESTAMP
      }
    }
  })

  try {
    useAppStore.setState({
      composerDrafts: {
        __new__: {
          text: 'Carry this into the new chat',
          images: [],
          files: [],
          enabledSkillNames: null
        }
      },
      reasoningEffortByThread: {
        __new__: 'high'
      }
    })

    await useAppStore.getState().createNewThread()

    const state = useAppStore.getState()
    assert.deepEqual(createThreadInputs, [{ reasoningEffort: 'high' }])
    assert.equal(state.activeThreadId, 'thread-2')
    assert.equal(state.reasoningEffortByThread.__new__, undefined)
    assert.equal(state.reasoningEffortByThread['thread-2'], 'high')
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
