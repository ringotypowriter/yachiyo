import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_ENABLED_TOOL_NAMES,
  type SettingsConfig
} from '../../../../shared/yachiyo/protocol.ts'
import {
  DEFAULT_SIDEBAR_FILTER,
  DEFAULT_SETTINGS,
  getComposerReasoningEffort,
  getEffectiveModel,
  getThreadEffectiveModel,
  useAppStore
} from './useAppStore.ts'

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

test('selectModel allows an existing non-vision thread to switch to a vision model', async () => {
  resetStore()

  const config: SettingsConfig = {
    providers: [
      {
        name: 'work',
        type: 'openai',
        apiKey: '',
        baseUrl: '',
        modelList: {
          enabled: ['text-model', 'vision-model'],
          disabled: [],
          imageIncapable: ['text-model']
        }
      }
    ],
    defaultModel: { providerName: 'work', model: 'text-model' }
  }
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
        headMessageId: 'msg-1',
        updatedAt: TIMESTAMP,
        modelOverride: input.modelOverride ?? undefined
      }
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      config,
      threads: [
        {
          id: 'thread-1',
          title: 'Thread',
          headMessageId: 'msg-1',
          modelOverride: { providerName: 'work', model: 'text-model' },
          updatedAt: TIMESTAMP
        }
      ]
    })

    await useAppStore.getState().selectModel('work', 'vision-model')

    assert.deepEqual(overrideCalls, [
      { threadId: 'thread-1', providerName: 'work', model: 'vision-model' }
    ])
    const thread = useAppStore.getState().threads.find((t) => t.id === 'thread-1')
    assert.deepEqual(thread?.modelOverride, { providerName: 'work', model: 'vision-model' })
  } finally {
    restoreWindow()
  }
})

test('getComposerReasoningEffort uses the persisted thread reasoning effort', () => {
  resetStore()

  useAppStore.setState({
    activeThreadId: 'thread-1',
    threads: [
      {
        id: 'thread-1',
        title: 'Thread',
        reasoningEffort: 'high',
        updatedAt: TIMESTAMP
      }
    ]
  })

  assert.equal(getComposerReasoningEffort(useAppStore.getState(), 'thread-1'), 'high')
})

test('setComposerReasoningEffort persists the active thread reasoning effort', async () => {
  resetStore()

  const calls: Array<{ threadId: string; reasoningEffort: string | null }> = []
  const restoreWindow = withWindowApiMock({
    setThreadReasoningEffort: async (input) => {
      calls.push(input)
      return {
        id: input.threadId,
        title: 'Thread',
        reasoningEffort: input.reasoningEffort ?? undefined,
        updatedAt: TIMESTAMP
      }
    }
  })

  try {
    useAppStore.setState({
      activeThreadId: 'thread-1',
      threads: [{ id: 'thread-1', title: 'Thread', updatedAt: TIMESTAMP }]
    })

    useAppStore.getState().setComposerReasoningEffort('high')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(calls, [{ threadId: 'thread-1', reasoningEffort: 'high' }])
    const thread = useAppStore.getState().threads.find((t) => t.id === 'thread-1')
    assert.equal(thread?.reasoningEffort, 'high')
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
