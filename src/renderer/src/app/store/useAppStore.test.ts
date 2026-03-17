import assert from 'node:assert/strict'
import test from 'node:test'

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
    activeRunId: null,
    activeRequestMessageId: null,
    activeRunThreadId: null,
    activeThreadId: null,
    composerDrafts: {},
    config: null,
    connectionStatus: 'connected',
    harnessEvents: {},
    initialized: false,
    isBootstrapping: false,
    lastError: null,
    latestRunsByThread: {},
    messages: {},
    pendingAssistantMessages: {},
    runPhase: 'idle',
    runStatus: 'idle',
    settings: DEFAULT_SETTINGS,
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

test('sendMessage restores per-thread drafts and clears only the sent thread on success', async () => {
  resetStore()

  const calls: Array<{ content: string; threadId: string }> = []
  const restoreWindow = withWindowApiMock({
    sendChat: async (input) => {
      calls.push({
        content: input.content,
        threadId: input.threadId
      })

      return {
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

test('retryMessage marks the accepted run as active immediately', async () => {
  resetStore()

  const restoreWindow = withWindowApiMock({
    retryMessage: async (input) => ({
      runId: 'run-retry-1',
      thread: {
        id: input.threadId,
        title: 'Thread one',
        updatedAt: TIMESTAMP
      },
      requestMessageId: 'user-1',
      sourceAssistantMessageId: input.messageId
    })
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
