import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SETTINGS_CONFIG } from '../../../../settings/settingsStore.ts'
import type { MemoryService } from '../../../../services/memory/memoryService.ts'
import type {
  ProviderSettings,
  ThreadRecord,
  TodoItemRecord
} from '../../../../../../shared/yachiyo/protocol.ts'
import type { RunState } from '../runTypes.ts'
import { buildRunExecutionDeps, type RunExecutionDepsContext } from './runExecutionDeps.ts'

const NOW = '2026-05-18T00:00:00.000Z'

test('run execution deps read todo items from the persisted thread snapshot', () => {
  const todoItems: TodoItemRecord[] = [
    { id: 'todo-1', content: 'Inspect the flow', status: 'completed' },
    { id: 'todo-2', content: 'Persist the widget', status: 'in_progress' }
  ]
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: NOW,
    todoItems
  }
  const { executionDeps } = setupRunExecutionDeps(thread)

  assert.deepEqual(executionDeps.getTodoItems?.(), todoItems)
})

test('run execution deps persist todo updates onto the thread snapshot', () => {
  let thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: NOW,
    todoItems: [{ id: 'todo-1', content: 'Inspect the flow', status: 'pending' }]
  }
  const { activeRun, emittedEvents, executionDeps } = setupRunExecutionDeps(thread, {
    updateThread: (updatedThread) => {
      thread = updatedThread
    },
    requireThread: () => thread
  })
  const updatedItems: TodoItemRecord[] = [
    { id: 'todo-1', content: 'Inspect the flow', status: 'completed' },
    { id: 'todo-2', content: 'Persist the widget', status: 'in_progress' }
  ]

  executionDeps.onTodoListUpdated?.({ items: updatedItems, step: 4 })

  assert.deepEqual(thread.todoItems, updatedItems)
  assert.deepEqual(activeRun.todoProgress?.items, updatedItems)
  assert.equal(activeRun.agentStepCount, 4)
  assert.deepEqual(emittedEvents, [
    {
      type: 'todo.updated',
      threadId: 'thread-1',
      runId: 'run-1',
      requestMessageId: 'request-1',
      runTrigger: 'local',
      items: updatedItems
    }
  ])
})

test('run execution deps route todo updates through the scoped run storage and emit', () => {
  let thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: NOW,
    todoItems: [{ id: 'todo-1', content: 'Inspect the flow', status: 'pending' }]
  }
  let realStorageUpdateCount = 0
  const scopedEvents: unknown[] = []
  const { executionDeps } = setupRunExecutionDeps(thread, {
    updateThread: () => {
      realStorageUpdateCount += 1
    },
    requireThread: () => thread,
    scopedStorage: {
      getThread: () => thread,
      updateThread: (updatedThread: ThreadRecord) => {
        thread = updatedThread
      }
    },
    scopedEmit: (event) => {
      scopedEvents.push(event)
    }
  })
  const updatedItems: TodoItemRecord[] = [
    { id: 'todo-1', content: 'Inspect the flow', status: 'completed' }
  ]

  executionDeps.onTodoListUpdated?.({ items: updatedItems, step: 2 })

  assert.equal(realStorageUpdateCount, 0)
  assert.deepEqual(thread.todoItems, updatedItems)
  assert.deepEqual(scopedEvents, [
    {
      type: 'todo.updated',
      threadId: 'thread-1',
      runId: 'run-1',
      requestMessageId: 'request-1',
      runTrigger: 'local',
      items: updatedItems
    }
  ])
})

function setupRunExecutionDeps(
  initialThread: ThreadRecord,
  overrides: {
    requireThread?: (threadId: string) => ThreadRecord
    updateThread?: (thread: ThreadRecord) => void
    scopedEmit?: (event: unknown) => void
    scopedStorage?: {
      getThread?: (threadId: string) => ThreadRecord | undefined
      updateThread?: (thread: ThreadRecord) => void
    }
  } = {}
): {
  activeRun: RunState
  emittedEvents: unknown[]
  executionDeps: ReturnType<typeof buildRunExecutionDeps>
} {
  const activeRun: RunState = {
    threadId: initialThread.id,
    requestMessageId: 'request-1',
    abortController: new AbortController(),
    executionPhase: 'generating',
    runTrigger: 'local',
    updateHeadOnComplete: true
  }
  const activeRuns = new Map<string, RunState>([['run-1', activeRun]])
  const emittedEvents: unknown[] = []
  const settings: ProviderSettings = {
    providerName: 'test',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: '',
    baseUrl: ''
  }
  const memoryService = {
    hasHiddenSearchCapability: () => false,
    isConfigured: () => false,
    searchMemories: async () => [],
    testConnection: async () => ({ ok: true, message: 'ok' }),
    recallForContext: async () => ({
      entries: [],
      thread: initialThread
    }),
    createMemory: async () => ({ savedCount: 0 }),
    validateAndCreateMemory: async () => ({ savedCount: 0 }),
    distillCompletedRun: async () => ({ savedCount: 0 }),
    saveThread: async () => ({ savedCount: 0 })
  } as unknown as MemoryService
  const context = {
    deps: {
      storage: {
        getThread: overrides.requireThread ?? (() => initialThread),
        updateThread: overrides.updateThread ?? (() => {})
      },
      createId: () => 'id',
      timestamp: () => NOW,
      emit: (event: unknown) => {
        emittedEvents.push(event)
      },
      createModelRuntime: () => ({}),
      ensureThreadWorkspace: async () => '/tmp/yachiyo',
      memoryService,
      readConfig: () => DEFAULT_SETTINGS_CONFIG,
      readSettings: () => settings,
      requireThread: overrides.requireThread ?? (() => initialThread),
      loadThreadMessages: () => [],
      loadThreadToolCalls: () => [],
      listSkills: async () => []
    },
    activeRuns,
    activeRunByThread: new Map([[initialThread.id, 'run-1']]),
    activeRunTasks: new Map(),
    backgroundTaskRunContext: new Map(),
    backgroundBashManager: {
      getCompletedTask: () => undefined
    },
    createSendChatFlowContext: () => ({}),
    setLastRunEnabledTools: () => {}
  } as unknown as RunExecutionDepsContext

  return {
    activeRun,
    emittedEvents,
    executionDeps: buildRunExecutionDeps(context, {
      loopInput: {
        enabledTools: [],
        runTrigger: 'local',
        runId: 'run-1',
        thread: initialThread,
        requestMessageId: 'request-1',
        updateHeadOnComplete: true
      },
      currentThread: initialThread,
      activeRun,
      isRecapRun: false,
      storage: {
        ...context.deps.storage,
        getThread: overrides.scopedStorage?.getThread ?? context.deps.storage.getThread,
        updateThread: overrides.scopedStorage?.updateThread ?? context.deps.storage.updateThread
      },
      emit: overrides.scopedEmit ?? context.deps.emit
    })
  }
}
