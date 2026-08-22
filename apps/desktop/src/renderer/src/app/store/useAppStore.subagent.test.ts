import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENABLED_TOOL_NAMES } from '@yachiyo/shared/protocol'
import { hydrateSubagentSnapshotState, selectSubagentSnapshotIds } from './useAppStore/helpers.ts'

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
    globalProcessingTasks: [],
    config: null,
    connectionStatus: 'connected',
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    subagentActiveIdsByThread: {},
    subagentProgressTimelineByThread: {},
    subagentStateById: {},
    subagentSnapshotsById: {},
    subagentSnapshotIdsByThread: {},
    subagentFinishedResultsByThread: {},
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

test('subagent snapshot selector reuses an empty list for missing threads', () => {
  resetStore()

  const state = useAppStore.getState()
  const noThread = selectSubagentSnapshotIds(state, null)
  const noThreadAgain = selectSubagentSnapshotIds(state, null)
  const missingThread = selectSubagentSnapshotIds(state, 'missing-thread')
  const missingThreadAgain = selectSubagentSnapshotIds(state, 'missing-thread')

  assert.strictEqual(noThread, noThreadAgain)
  assert.strictEqual(missingThread, missingThreadAgain)
  assert.strictEqual(noThread, missingThread)
})

test('subagent.updated upserts snapshots independently of the parent run and retains terminal state', () => {
  resetStore()

  const snapshot = {
    agentId: 'agent-1',
    parentThreadId: 'thread-1',
    launchRunId: 'run-completed',
    agentName: 'review',
    agentType: 'review' as const,
    codeName: 'Kaze',
    workspacePath: '/tmp/workspace-a',
    state: 'running' as const,
    startedAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    lastOutput: 'checking files'
  }

  useAppStore.getState().applyServerEvent({
    type: 'subagent.updated',
    eventId: 'event-subagent-updated-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-completed',
    agentId: 'agent-1',
    launchRunId: 'run-completed',
    snapshot
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.updated',
    eventId: 'event-subagent-updated-2',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-completed',
    agentId: 'agent-1',
    launchRunId: 'run-completed',
    snapshot: { ...snapshot, state: 'closed', updatedAt: '2026-03-15T00:00:01.000Z' }
  })

  const state = useAppStore.getState()
  assert.equal(state.subagentSnapshotsById['agent-1']?.state, 'closed')
  assert.deepEqual(useAppStore.getState().subagentActiveIdsByThread['thread-1'] ?? [], [])
  assert.deepEqual(state.subagentSnapshotIdsByThread['thread-1'], ['agent-1'])
})

test('subagent hydration does not overwrite a newer event snapshot', () => {
  resetStore()

  const newestSnapshot = {
    agentId: 'agent-1',
    parentThreadId: 'thread-1',
    launchRunId: 'run-1',
    agentName: 'review',
    agentType: 'review' as const,
    codeName: 'Kaze',
    workspacePath: '/tmp/workspace-a',
    state: 'closed' as const,
    startedAt: TIMESTAMP,
    updatedAt: '2026-03-15T00:00:02.000Z'
  }
  useAppStore.getState().applyServerEvent({
    type: 'subagent.updated',
    eventId: 'event-subagent-updated-newest',
    timestamp: newestSnapshot.updatedAt,
    threadId: 'thread-1',
    runId: 'run-1',
    agentId: newestSnapshot.agentId,
    launchRunId: newestSnapshot.launchRunId,
    snapshot: newestSnapshot
  })

  const state = useAppStore.getState()
  const next = hydrateSubagentSnapshotState(
    {
      subagentSnapshotsById: state.subagentSnapshotsById,
      subagentSnapshotIdsByThread: state.subagentSnapshotIdsByThread
    },
    [{ ...newestSnapshot, state: 'running', updatedAt: TIMESTAMP }],
    'thread-1'
  )

  assert.equal(next.subagentSnapshotsById['agent-1']?.state, 'closed')
  assert.equal(next.subagentSnapshotsById['agent-1']?.updatedAt, '2026-03-15T00:00:02.000Z')
  assert.deepEqual(next.subagentSnapshotIdsByThread['thread-1'], ['agent-1'])

  const afterMissingResponse = hydrateSubagentSnapshotState(next, [], 'thread-1', {
    removalBaselineUpdatedAtById: { 'agent-1': TIMESTAMP }
  })
  assert.equal(afterMissingResponse.subagentSnapshotsById['agent-1']?.state, 'closed')
  assert.deepEqual(afterMissingResponse.subagentSnapshotIdsByThread['thread-1'], ['agent-1'])
})
test('Agent activity events stay keyed by agentId after the parent run ends', () => {
  resetStore()
  const snapshot = {
    agentId: 'agent-1',
    parentThreadId: 'thread-1',
    launchRunId: 'run-ended',
    agentName: 'general',
    agentType: 'general' as const,
    codeName: 'Kaze',
    workspacePath: '/tmp/workspace-a',
    state: 'running' as const,
    startedAt: TIMESTAMP,
    updatedAt: TIMESTAMP
  }

  useAppStore.getState().applyServerEvent({
    type: 'subagent.updated',
    eventId: 'event-subagent-updated',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-ended',
    agentId: 'agent-1',
    launchRunId: 'run-ended',
    snapshot
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.progress',
    eventId: 'event-subagent-progress',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-ended',
    delegationId: 'delegate-tool-id',
    agentId: 'agent-1',
    chunk: 're-read before writing\n'
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.toolCall',
    eventId: 'event-subagent-tool',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-ended',
    delegationId: 'delegate-tool-id',
    agentId: 'agent-1',
    turnId: 'turn-1',
    toolName: 'read',
    inputSummary: 'src/main.ts',
    status: 'completed'
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.message',
    eventId: 'event-subagent-message',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-ended',
    agentId: 'agent-1',
    launchRunId: 'run-ended',
    envelope: {
      id: 'message-1',
      teamThreadId: 'thread-1',
      sequence: 1,
      from: { kind: 'parent', threadId: 'thread-1' },
      to: { kind: 'agent', agentId: 'agent-1' },
      message: 'Please verify the final diff.',
      createdAt: TIMESTAMP
    }
  })

  const activity = useAppStore.getState().subagentStateById['agent-1']
  assert.equal(activity?.progress, 're-read before writing\n')
  assert.equal(activity?.lastMessage, 'Please verify the final diff.')
  assert.equal(activity?.recentToolCalls?.[0]?.toolName, 'read')
  assert.deepEqual(useAppStore.getState().subagentActiveIdsByThread['thread-1'], ['agent-1'])
})

test('applyServerEvent does not keep delegateTask placeholder alongside the real subagent', () => {
  resetStore()

  useAppStore.getState().applyServerEvent({
    type: 'tool.updated',
    eventId: 'event-tool-delegate-running',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    toolCall: {
      id: 'tool-delegate',
      runId: 'run-1',
      threadId: 'thread-1',
      requestMessageId: 'user-1',
      toolName: 'delegateTask',
      status: 'running',
      inputSummary: 'review',
      startedAt: TIMESTAMP
    }
  })

  assert.equal(useAppStore.getState().subagentActiveIdsByThread['thread-1'], undefined)

  useAppStore.getState().applyServerEvent({
    type: 'subagent.started',
    eventId: 'event-subagent-started-real',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'worker-delegate',
    agentName: 'review',
    agentType: 'review',
    workspacePath: '/tmp/workspace-a',
    codeName: 'Kaze'
  })

  const state = useAppStore.getState()

  assert.deepEqual(state.subagentActiveIdsByThread['thread-1'], ['worker-delegate'])
  assert.equal(state.subagentStateById['tool-delegate'], undefined)
  assert.equal(state.subagentStateById['worker-delegate']?.codeName, 'Kaze')
})

test('applyServerEvent replaces a rehydrated delegateTask placeholder with the real subagent', () => {
  resetStore()
  useAppStore.setState({
    config: {
      providers: [],
      general: { notifyCodingTaskStarted: false }
    }
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.state.replaced',
    eventId: 'event-thread-state-replaced-placeholder',
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
        id: 'tool-delegate',
        runId: 'run-1',
        threadId: 'thread-1',
        requestMessageId: 'user-1',
        toolName: 'delegateTask',
        status: 'running',
        inputSummary: 'review',
        startedAt: TIMESTAMP
      }
    ]
  })

  assert.deepEqual(useAppStore.getState().subagentActiveIdsByThread['thread-1'], ['tool-delegate'])

  useAppStore.getState().applyServerEvent({
    type: 'subagent.started',
    eventId: 'event-subagent-started-real-after-rehydrate',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'worker-delegate',
    agentName: 'review',
    agentType: 'review',
    workspacePath: '/tmp/workspace-a',
    codeName: 'Kaze'
  })

  const state = useAppStore.getState()

  assert.deepEqual(state.subagentActiveIdsByThread['thread-1'], ['worker-delegate'])
  assert.equal(state.subagentStateById['tool-delegate'], undefined)
  assert.equal(state.subagentStateById['worker-delegate']?.codeName, 'Kaze')
})

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
    status: 'success',
    lastMessage: 'worker final result'
  })

  const state = useAppStore.getState()

  assert.deepEqual(state.subagentActiveIdsByThread['thread-1'], ['delegate-2'])
  assert.equal(state.subagentStateById['delegate-1'], undefined)
  assert.equal(
    state.subagentFinishedResultsByThread['thread-1']?.[0]?.lastMessage,
    'worker final result'
  )
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
        toolName: 'delegateTask',
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

test('thread replacement preserves snapshot-backed activity in unaffected threads', () => {
  resetStore()

  const snapshot = {
    agentId: 'agent-thread-2',
    parentThreadId: 'thread-2',
    launchRunId: 'run-2',
    agentName: 'Review Worker',
    agentType: 'review' as const,
    codeName: 'Kaze',
    workspacePath: '/tmp/workspace-b',
    state: 'running' as const,
    startedAt: TIMESTAMP,
    updatedAt: TIMESTAMP
  }
  useAppStore.getState().applyServerEvent({
    type: 'subagent.updated',
    eventId: 'event-subagent-updated-thread-2',
    timestamp: TIMESTAMP,
    threadId: 'thread-2',
    runId: 'run-2',
    agentId: snapshot.agentId,
    launchRunId: snapshot.launchRunId,
    snapshot
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.progress',
    eventId: 'event-subagent-progress-thread-2',
    timestamp: TIMESTAMP,
    threadId: 'thread-2',
    runId: 'run-2',
    delegationId: snapshot.agentId,
    agentId: snapshot.agentId,
    chunk: 'sibling progress\n'
  })

  useAppStore.getState().applyServerEvent({
    type: 'subagent.started',
    eventId: 'event-subagent-started-thread-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-thread-1',
    agentName: 'Parent Worker',
    workspacePath: '/tmp/workspace-a'
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.progress',
    eventId: 'event-subagent-progress-thread-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-thread-1',
    chunk: 'parent progress\n'
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.state.replaced',
    eventId: 'event-thread-state-replaced-thread-1',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    thread: {
      id: 'thread-1',
      title: 'Thread 1',
      updatedAt: TIMESTAMP,
      headMessageId: 'message-1'
    },
    messages: [],
    toolCalls: []
  })

  const state = useAppStore.getState()
  assert.deepEqual(state.subagentActiveIdsByThread['thread-2'], ['agent-thread-2'])
  assert.equal(state.subagentStateById['agent-thread-2']?.agentName, 'Review Worker')
  assert.deepEqual(state.subagentActiveIdsByThread['thread-1'] ?? [], [])
  assert.equal(state.subagentStateById['delegate-thread-1'], undefined)
  assert.equal(state.subagentStateById['agent-thread-2']?.progress, 'sibling progress\n')
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

test('applyServerEvent upserts subagent tool calls with input and output summaries', () => {
  resetStore()

  useAppStore.getState().applyServerEvent({
    type: 'subagent.started',
    eventId: 'event-subagent-started-tools',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-1',
    agentName: 'Worker',
    workspacePath: '/tmp/workspace-a'
  })

  useAppStore.getState().applyServerEvent({
    type: 'subagent.toolCall',
    eventId: 'event-subagent-tool-call-start',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-1',
    toolCallId: 'tool-1',
    toolName: 'glob',
    inputSummary: '**/*.ts',
    status: 'running'
  })
  useAppStore.getState().applyServerEvent({
    type: 'subagent.toolCall',
    eventId: 'event-subagent-tool-call-end',
    timestamp: TIMESTAMP,
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegate-1',
    toolCallId: 'tool-1',
    toolName: 'glob',
    inputSummary: '**/*.ts',
    outputSummary: 'found 8 files',
    status: 'completed'
  })

  assert.deepEqual(useAppStore.getState().subagentStateById['delegate-1']?.recentToolCalls, [
    {
      toolCallId: 'tool-1',
      toolName: 'glob',
      inputSummary: '**/*.ts',
      outputSummary: 'found 8 files',
      status: 'completed'
    }
  ])
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
        toolName: 'delegateTask',
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
