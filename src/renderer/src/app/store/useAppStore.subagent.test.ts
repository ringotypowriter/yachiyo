import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENABLED_TOOL_NAMES } from '../../../../shared/yachiyo/protocol.ts'
import { DEFAULT_SETTINGS, useAppStore } from './useAppStore.ts'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'

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
    subagentActiveIdsByThread: {},
    subagentProgressTimelineByThread: {},
    subagentStateById: {},
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

test('applyServerEvent keeps sibling delegated agents isolated by delegationId', () => {
  resetStore()

  useAppStore.getState().applyServerEvent({
    type: 'subagent.started',
    eventId: 'event-subagent-started-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-1',
    agentName: 'Worker',
    workspacePath: '/tmp/workspace-a'
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.started',
    eventId: 'event-subagent-started-2',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-2',
    agentName: 'Worker',
    workspacePath: '/tmp/workspace-b'
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.progress',
    eventId: 'event-subagent-progress-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-1',
    chunk: 'alpha\n'
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.progress',
    eventId: 'event-subagent-progress-2',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-2',
    chunk: 'beta\n'
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.finished',
    eventId: 'event-subagent-finished-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-1',
    agentName: 'Worker',
    status: 'success'
  })

  const state = useAppStore.getState()

  assert.deepEqual(state.subagentActiveIdsByThread['thread-1'], ['delegate-2'])
  assert.equal(state.subagentStateById['delegate-1'], undefined)
  assert.equal(state.subagentStateById['delegate-2']?.progress, 'beta\n')
  assert.deepEqual(
    state.subagentProgressTimelineByThread['thread-1']?.map((entry) => [
      entry.delegationId,
      entry.chunk
    ]),
    [
      ['delegate-1', 'alpha\n'],
      ['delegate-2', 'beta\n']
    ]
  )
})

test('applyServerEvent preserves existing delegated progress when thread state is rehydrated', () => {
  resetStore()

  useAppStore.getState().applyServerEvent({
    type: 'subagent.started',
    eventId: 'event-subagent-started-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-1',
    agentName: 'Worker',
    workspacePath: '/tmp/workspace-a'
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.progress',
    eventId: 'event-subagent-progress-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-1',
    chunk: 'alpha\nbeta\n'
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.state.replaced',
    eventId: 'event-thread-state-replaced',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    thread: {
      id: 'thread-1',
      title: 'Thread 1',
      updatedAt: TIMESTAMP,
      headMessageId: 'message-1'
    },
    messages: [],
    toolCalls: [
      {
        id: 'delegate-1',
        runId: 'run-1',
        threadId: 'thread-1',
        requestMessageId: 'user-1',
        toolName: 'delegateCodingTask',
        status: 'running',
        inputSummary: 'Worker',
        startedAt: TIMESTAMP
      }
    ]
  })

  const state = useAppStore.getState()

  assert.deepEqual(state.subagentActiveIdsByThread['thread-1'], ['delegate-1'])
  assert.equal(state.subagentStateById['delegate-1']?.progress, 'alpha\nbeta\n')
  assert.equal(state.subagentStateById['delegate-1']?.agentName, 'Worker')
  assert.deepEqual(
    state.subagentProgressTimelineByThread['thread-1']?.map((entry) => entry.chunk),
    ['alpha\nbeta\n']
  )
})

test('applyServerEvent clears stale thread progress when a new first delegation starts', () => {
  resetStore()

  useAppStore.setState({
    subagentProgressTimelineByThread: {
      'thread-1': [{ delegationId: 'stale-delegate', agentName: 'Worker', chunk: 'stale\n' }]
    }
  })

  useAppStore.getState().applyServerEvent({
    type: 'subagent.started',
    eventId: 'event-subagent-started-fresh',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-2',
    delegationId: 'delegate-fresh',
    agentName: 'Fresh Worker',
    workspacePath: '/tmp/workspace-fresh'
  })

  useAppStore.getState().applyServerEvent({
    type: 'subagent.progress',
    eventId: 'event-subagent-progress-fresh',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-2',
    delegationId: 'delegate-fresh',
    chunk: 'fresh\n'
  })

  const state = useAppStore.getState()

  assert.deepEqual(state.subagentActiveIdsByThread['thread-1'], ['delegate-fresh'])
  assert.deepEqual(
    state.subagentProgressTimelineByThread['thread-1']?.map((entry) => [
      entry.delegationId,
      entry.chunk
    ]),
    [['delegate-fresh', 'fresh\n']]
  )
})

test('thread.state.replaced drops progress entries for delegations that are no longer active', () => {
  resetStore()

  useAppStore.getState().applyServerEvent({
    type: 'subagent.started',
    eventId: 'event-subagent-started-old',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-old',
    agentName: 'Old Worker',
    workspacePath: '/tmp/workspace-old'
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.progress',
    eventId: 'event-subagent-progress-old',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-old',
    chunk: 'old\n'
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.state.replaced',
    eventId: 'event-thread-state-replaced-switch',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    thread: {
      id: 'thread-1',
      title: 'Thread 1',
      updatedAt: TIMESTAMP,
      headMessageId: 'message-2'
    },
    messages: [],
    toolCalls: [
      {
        id: 'delegate-new',
        runId: 'run-2',
        threadId: 'thread-1',
        requestMessageId: 'user-2',
        toolName: 'delegateCodingTask',
        status: 'running',
        inputSummary: 'New Worker',
        startedAt: TIMESTAMP
      }
    ]
  })

  const state = useAppStore.getState()

  assert.deepEqual(state.subagentActiveIdsByThread['thread-1'], ['delegate-new'])
  assert.equal(state.subagentStateById['delegate-old'], undefined)
  assert.deepEqual(state.subagentProgressTimelineByThread['thread-1'] ?? [], [])
})
