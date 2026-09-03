import type { YachiyoPreloadYachiyoApi } from '../../../../preload/index.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ENABLED_TOOL_NAMES } from '@yachiyo/shared/protocol'
import { DEFAULT_SETTINGS, useAppStore } from './useAppStore.ts'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'

type LoadThreadData = YachiyoPreloadYachiyoApi['loadThreadData']
type ThreadData = Awaited<ReturnType<LoadThreadData>>

function message(id: string, threadId: string): ThreadData['messages'][number] {
  return {
    id,
    threadId,
    role: 'user',
    content: id,
    status: 'completed',
    createdAt: TIMESTAMP
  } as ThreadData['messages'][number]
}

function ids(messages: { id: string }[] | undefined): string[] {
  return (messages ?? []).map((entry) => entry.id)
}

/** A loadThreadData whose response is settled by the test, not by the runtime. */
function deferredLoadThreadData(): {
  install: (extraApi?: Record<string, unknown>) => () => void
  settle: (data: Partial<ThreadData>) => Promise<void>
  planDocumentReads: () => number
  subagentListings: () => number
  threadReads: () => number
} {
  let resolveRead: ((data: ThreadData) => void) | null = null
  let planDocumentReads = 0
  let subagentListings = 0
  let threadReads = 0
  const globalScope = globalThis as typeof globalThis & { window?: unknown }
  let originalWindow: unknown

  return {
    install: (extraApi: Record<string, unknown> = {}) => {
      originalWindow = globalScope.window
      Object.defineProperty(globalScope, 'window', {
        value: {
          api: {
            yachiyo: {
              listSkills: async () => [],
              listThings: async () => [],
              loadThreadData: () => {
                threadReads += 1
                return new Promise<ThreadData>((resolve) => {
                  resolveRead = resolve
                })
              },
              readThreadPlanDocument: async () => {
                planDocumentReads += 1
                return { path: '.yachiyo/plan.md', content: '# Plan' }
              },
              listSubagents: async () => {
                subagentListings += 1
                return []
              },
              ...extraApi
            }
          }
        },
        configurable: true,
        writable: true
      })
      return () => {
        if (originalWindow === undefined) Reflect.deleteProperty(globalScope, 'window')
        else
          Object.defineProperty(globalScope, 'window', {
            value: originalWindow,
            configurable: true,
            writable: true
          })
      }
    },
    planDocumentReads: () => planDocumentReads,
    subagentListings: () => subagentListings,
    threadReads: () => threadReads,
    settle: async (data) => {
      assert.ok(resolveRead, 'expected a thread read to be in flight')
      resolveRead({
        messages: [],
        queuedFollowUpMessages: [],
        toolCalls: [],
        runs: [],
        ...data
      } as ThreadData)
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

function deleteThread(threadId: string): void {
  useAppStore.getState().applyServerEvent({
    type: 'thread.deleted',
    eventId: `event-deleted-${threadId}`,
    timestamp: TIMESTAMP,
    threadId
  } as Parameters<ReturnType<typeof useAppStore.getState>['applyServerEvent']>[0])
}

function archiveThread(threadId: string): void {
  useAppStore.getState().applyServerEvent({
    type: 'thread.archived',
    eventId: `event-archived-${threadId}`,
    timestamp: TIMESTAMP,
    threadId,
    thread: { id: threadId, title: 'Thread', updatedAt: TIMESTAMP, archivedAt: TIMESTAMP }
  } as Parameters<ReturnType<typeof useAppStore.getState>['applyServerEvent']>[0])
}

function replaceThreadState(threadId: string, messages: ThreadData['messages']): void {
  useAppStore.getState().applyServerEvent({
    type: 'thread.state.replaced',
    eventId: `event-${threadId}-${messages.length}`,
    timestamp: TIMESTAMP,
    threadId,
    thread: { id: threadId, title: 'Thread', updatedAt: TIMESTAMP },
    messages,
    toolCalls: [],
    queuedFollowUpMessages: []
  } as Parameters<ReturnType<typeof useAppStore.getState>['applyServerEvent']>[0])
}

test('a sync refresh that lands first is not truncated by the page it raced', async () => {
  // Opening a thread reads its newest page. If a sync refresh pushes the whole
  // thread while that page is in flight, applying the page afterwards cuts the
  // authoritative history back down to one page — no error, just older
  // messages gone. This is the constraint the whole feature rests on.
  const read = deferredLoadThreadData()
  const restoreWindow = read.install()
  const full = Array.from({ length: 120 }, (_, index) => message(`m${index}`, 'thread-1'))

  useAppStore.setState({
    activeThreadId: null,
    messages: {},
    toolCalls: {},
    threads: [{ id: 'thread-1', title: 'Thread', updatedAt: TIMESTAMP }]
  })

  try {
    useAppStore.getState().setActiveThread('thread-1')
    replaceThreadState('thread-1', full)
    await read.settle({ messages: full.slice(-60) })

    assert.equal(useAppStore.getState().messages['thread-1']?.length, 120)
  } finally {
    restoreWindow()
  }
})

test('a sync refresh also survives the queued messages and tool calls of the page it raced', async () => {
  // thread.state.replaced authoritatively replaces queued follow-ups and tool
  // calls too, so a stale read must not write those back either.
  const read = deferredLoadThreadData()
  const restoreWindow = read.install()
  const full = [message('m0', 'thread-2')]

  useAppStore.setState({
    activeThreadId: null,
    messages: {},
    toolCalls: {},
    queuedFollowUpMessagesByThread: {},
    threads: [{ id: 'thread-2', title: 'Thread', updatedAt: TIMESTAMP }]
  })

  try {
    useAppStore.getState().setActiveThread('thread-2')
    replaceThreadState('thread-2', full)
    await read.settle({
      messages: full,
      queuedFollowUpMessages: [{ id: 'stale-queued', content: 'stale' }],
      toolCalls: [{ id: 'stale-tool' }]
    } as Partial<ThreadData>)

    const state = useAppStore.getState()
    assert.deepEqual(ids(state.queuedFollowUpMessagesByThread['thread-2']), [])
    assert.deepEqual(ids(state.toolCalls['thread-2']), [])
  } finally {
    restoreWindow()
  }
})

test('a stale page does not hydrate a plan document from the payload it lost with', async () => {
  // hydratePlanDocumentForThread runs outside the store update, reading the
  // response payload directly. Gating only the state write would let the
  // discarded payload take effect through this side door.
  const read = deferredLoadThreadData()
  const restoreWindow = read.install()

  useAppStore.setState({
    activeThreadId: null,
    messages: {},
    toolCalls: {},
    planDocumentsByThread: {},
    threads: [{ id: 'thread-3', title: 'Thread', updatedAt: TIMESTAMP }]
  })

  try {
    useAppStore.getState().setActiveThread('thread-3')
    replaceThreadState('thread-3', [message('m0', 'thread-3')])
    await read.settle({
      messages: [message('m0', 'thread-3')],
      toolCalls: [
        {
          id: 'tool-exit-plan',
          runId: 'run-plan',
          threadId: 'thread-3',
          toolName: 'exitPlanMode',
          status: 'completed',
          inputSummary: 'ready=true',
          startedAt: TIMESTAMP,
          finishedAt: TIMESTAMP
        }
      ]
    } as Partial<ThreadData>)

    assert.equal(read.planDocumentReads(), 0)
    assert.equal(useAppStore.getState().planDocumentsByThread['thread-3'], undefined)
  } finally {
    restoreWindow()
  }
})

test('a read that lands after its thread was deleted repopulates nothing', async () => {
  // thread.deleted drops every per-thread cache. A read dispatched before it
  // still resolves afterwards, and writing any of its payload — runs included —
  // leaves an orphan cache for a thread the user deleted.
  const read = deferredLoadThreadData()
  const restoreWindow = read.install()

  useAppStore.setState({
    activeThreadId: null,
    messages: {},
    toolCalls: {},
    runsByThread: {},
    planDocumentsByThread: {},
    threadMessagePaging: { 'thread-4': { hasOlder: true, loadingOlder: false } },
    threads: [{ id: 'thread-4', title: 'Thread', updatedAt: TIMESTAMP }]
  })

  try {
    useAppStore.getState().setActiveThread('thread-4')
    deleteThread('thread-4')
    await read.settle({
      messages: [message('m0', 'thread-4')],
      runs: [{ id: 'run-late', threadId: 'thread-4', status: 'completed', createdAt: TIMESTAMP }]
    } as Partial<ThreadData>)

    const state = useAppStore.getState()
    assert.equal(state.messages['thread-4'], undefined)
    assert.equal(state.runsByThread['thread-4'], undefined)
    assert.equal(state.threadMessagePaging['thread-4'], undefined)
    // Subagent hydration is a second read keyed by the same thread; running it
    // for a deleted thread repopulates the caches the delete just cleared.
    assert.equal(read.subagentListings(), 0)
  } finally {
    restoreWindow()
  }
})

test('a sync refresh settles paging, so a jump to a message it removed stops waiting', async () => {
  // A deep link can name a message the sync refresh proves is gone. The
  // snapshot is the whole thread, so leaving hasOlder true would keep the
  // timeline waiting for a page that can never arrive.
  useAppStore.setState({
    messages: { 'thread-5': [] },
    threadMessagePaging: { 'thread-5': { hasOlder: true, loadingOlder: false } }
  })

  replaceThreadState('thread-5', [message('m0', 'thread-5')])

  assert.deepEqual(useAppStore.getState().threadMessagePaging['thread-5'], {
    hasOlder: false,
    loadingOlder: false
  })
})

test('the boot read does not hydrate a plan a sync refresh retired mid-flight', () => {
  // Startup reads the active thread's newest page. If sync replaces that
  // thread while the read is in flight, the read's payload is discarded — and
  // the plan hydration that reads the same payload has to be discarded with
  // it, or a retired plan comes back through the side door.
  const read = deferredLoadThreadData()
  const restoreWindow = read.install({
    bootstrap: async () => ({
      threads: [{ id: 'thread-boot', title: 'Thread', updatedAt: TIMESTAMP }],
      archivedThreads: [],
      folders: [],
      messagesByThread: {},
      toolCallsByThread: {},
      latestRunsByThread: {},
      recoveredInterruptedSaveThreadIds: [],
      config: { enabledTools: DEFAULT_ENABLED_TOOL_NAMES, providers: [] },
      settings: { ...DEFAULT_SETTINGS, apiKey: 'sk-test', model: 'gpt-5', providerName: 'work' }
    }),
    subscribe: () => () => undefined
  })

  return (async () => {
    try {
      const booting = useAppStore.getState().initialize()
      await new Promise((resolve) => setImmediate(resolve))
      replaceThreadState('thread-boot', [message('m0', 'thread-boot')])
      await read.settle({
        messages: [message('m0', 'thread-boot')],
        toolCalls: [
          {
            id: 'tool-exit-plan',
            runId: 'run-plan',
            threadId: 'thread-boot',
            toolName: 'exitPlanMode',
            status: 'completed',
            inputSummary: 'ready=true',
            startedAt: TIMESTAMP,
            finishedAt: TIMESTAMP
          }
        ]
      } as Partial<ThreadData>)
      await booting

      assert.equal(read.planDocumentReads(), 0)
      assert.equal(useAppStore.getState().planDocumentsByThread['thread-boot'], undefined)
    } finally {
      restoreWindow()
    }
  })()
})

test('a thread deleted before it is opened is never read at all', () => {
  // The tombstone already existed when this open was requested, so nothing
  // downstream would see a revision change. Refusing the open is what keeps a
  // stale search result from resurrecting a deleted thread's caches.
  const read = deferredLoadThreadData()
  const restoreWindow = read.install()

  useAppStore.setState({
    activeThreadId: 'thread-5b',
    messages: {},
    toolCalls: {},
    runsByThread: {},
    planDocumentsByThread: {},
    threadMessagePaging: {},
    threads: [
      { id: 'thread-5b', title: 'Kept', updatedAt: TIMESTAMP },
      { id: 'thread-6', title: 'Doomed', updatedAt: TIMESTAMP }
    ]
  })
  deleteThread('thread-6')

  try {
    useAppStore.getState().setActiveThread('thread-6')

    const state = useAppStore.getState()
    assert.equal(read.threadReads(), 0)
    assert.equal(state.messages['thread-6'], undefined)
    assert.equal(state.runsByThread['thread-6'], undefined)
    assert.equal(state.threadMessagePaging['thread-6'], undefined)
    assert.equal(read.subagentListings(), 0)
    assert.equal(read.planDocumentReads(), 0)
  } finally {
    restoreWindow()
  }
})

test('deleting the open thread retires a jump aimed at it', () => {
  // The reducer switches the active thread itself, bypassing setActiveThread,
  // which is what normally retires the intent. Left set, it follows the user
  // into the thread they land on.
  useAppStore.setState({
    activeThreadId: 'thread-7',
    scrollToMessage: { threadId: 'thread-7', messageId: 'm' },
    messages: { 'thread-7': [] },
    threads: [
      { id: 'thread-7', title: 'Thread', updatedAt: TIMESTAMP },
      { id: 'thread-8', title: 'Other', updatedAt: TIMESTAMP }
    ]
  })

  deleteThread('thread-7')

  assert.equal(useAppStore.getState().scrollToMessage, null)
})

test('deleting another thread leaves an unrelated jump alone', () => {
  useAppStore.setState({
    activeThreadId: 'thread-9',
    scrollToMessage: { threadId: 'thread-9', messageId: 'm' },
    messages: { 'thread-9': [] },
    threads: [
      { id: 'thread-9', title: 'Thread', updatedAt: TIMESTAMP },
      { id: 'thread-10', title: 'Other', updatedAt: TIMESTAMP }
    ]
  })

  deleteThread('thread-10')

  assert.equal(useAppStore.getState().scrollToMessage?.messageId, 'm')
})

test('archiving the open thread keeps a jump aimed at it, because it stays selected', () => {
  // Archiving moves the conversation into the archived view and selects it
  // there, so the jump is still reachable — the owner is what makes that
  // answerable at all.
  useAppStore.setState({
    activeThreadId: 'thread-11',
    activeArchivedThreadId: null,
    scrollToMessage: { threadId: 'thread-11', messageId: 'm' },
    messages: { 'thread-11': [] },
    threads: [
      { id: 'thread-11', title: 'Thread', updatedAt: TIMESTAMP },
      { id: 'thread-12', title: 'Other', updatedAt: TIMESTAMP }
    ],
    archivedThreads: []
  })

  archiveThread('thread-11')

  assert.equal(useAppStore.getState().activeArchivedThreadId, 'thread-11')
  assert.equal(useAppStore.getState().scrollToMessage?.messageId, 'm')
})

test('archiving the open thread retires the jump when the archived view shows something else', () => {
  // The archived view keeps whatever was already selected there, so the
  // archived thread is not on screen in either view and the jump is
  // unreachable.
  useAppStore.setState({
    activeThreadId: 'thread-11',
    activeArchivedThreadId: 'archived-other',
    scrollToMessage: { threadId: 'thread-11', messageId: 'm' },
    messages: { 'thread-11': [] },
    threads: [
      { id: 'thread-11', title: 'Thread', updatedAt: TIMESTAMP },
      { id: 'thread-12', title: 'Other', updatedAt: TIMESTAMP }
    ],
    archivedThreads: [
      { id: 'archived-other', title: 'Older', updatedAt: TIMESTAMP, archivedAt: TIMESTAMP }
    ]
  })

  archiveThread('thread-11')

  assert.equal(useAppStore.getState().activeArchivedThreadId, 'archived-other')
  assert.equal(useAppStore.getState().scrollToMessage, null)
})

test('restoring a thread retires a jump aimed at the one being left', () => {
  useAppStore.setState({
    activeThreadId: 'thread-13',
    scrollToMessage: { threadId: 'thread-13', messageId: 'm' },
    messages: { 'thread-13': [] },
    threads: [{ id: 'thread-13', title: 'Thread', updatedAt: TIMESTAMP }],
    archivedThreads: [
      { id: 'thread-14', title: 'Restored', updatedAt: TIMESTAMP, archivedAt: TIMESTAMP }
    ]
  })

  useAppStore.getState().applyServerEvent({
    type: 'thread.restored',
    eventId: 'event-restored',
    timestamp: TIMESTAMP,
    threadId: 'thread-14',
    thread: { id: 'thread-14', title: 'Restored', updatedAt: TIMESTAMP }
  } as Parameters<ReturnType<typeof useAppStore.getState>['applyServerEvent']>[0])

  assert.equal(useAppStore.getState().activeThreadId, 'thread-14')
  assert.equal(useAppStore.getState().scrollToMessage, null)
})

test('a stale deep-link into a deleted thread does not open it or set a jump', async () => {
  // The read was already refused, but setActiveThread itself still switched
  // the active thread and wrote the jump intent — an empty conversation with a
  // pending jump to a message that exists nowhere.
  const read = deferredLoadThreadData()
  const restoreWindow = read.install()

  useAppStore.setState({
    activeThreadId: 'thread-15',
    scrollToMessage: null,
    messages: { 'thread-15': [] },
    threads: [
      { id: 'thread-15', title: 'Kept', updatedAt: TIMESTAMP },
      { id: 'thread-16', title: 'Doomed', updatedAt: TIMESTAMP }
    ]
  })
  deleteThread('thread-16')

  try {
    useAppStore.getState().setActiveThread('thread-16', 'message-in-thread-16')

    const state = useAppStore.getState()
    assert.equal(state.activeThreadId, 'thread-15')
    assert.equal(state.scrollToMessage, null)
  } finally {
    restoreWindow()
  }
})

test('subagent hydration in flight when the thread is deleted writes nothing back', async () => {
  // The hydration has its own sequence guard, but that only defends against a
  // newer listing of the same thread — not against the thread going away.
  const listing: { resolve?: (snapshots: unknown[]) => void } = {}
  const globalScope = globalThis as typeof globalThis & { window?: unknown }
  const originalWindow = globalScope.window
  Object.defineProperty(globalScope, 'window', {
    value: {
      api: {
        yachiyo: {
          listSkills: async () => [],
          listThings: async () => [],
          loadThreadData: async () => ({
            messages: [],
            queuedFollowUpMessages: [],
            toolCalls: [],
            runs: []
          }),
          listSubagents: () =>
            new Promise((resolve) => {
              listing.resolve = resolve as (snapshots: unknown[]) => void
            })
        }
      }
    },
    configurable: true,
    writable: true
  })

  useAppStore.setState({
    activeThreadId: null,
    messages: {},
    subagentSnapshotsById: {},
    subagentSnapshotIdsByThread: {},
    threads: [
      { id: 'thread-17', title: 'Thread', updatedAt: TIMESTAMP },
      { id: 'thread-18', title: 'Other', updatedAt: TIMESTAMP }
    ]
  })

  try {
    useAppStore.getState().setActiveThread('thread-17')
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(listing.resolve, 'expected a subagent listing to be in flight')

    deleteThread('thread-17')
    listing.resolve([
      {
        agentId: 'agent-late',
        threadId: 'thread-17',
        status: 'completed',
        updatedAt: TIMESTAMP
      }
    ])
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(useAppStore.getState().subagentSnapshotIdsByThread['thread-17'], undefined)
    assert.equal(useAppStore.getState().subagentSnapshotsById['agent-late'], undefined)
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalScope, 'window')
    else
      Object.defineProperty(globalScope, 'window', {
        value: originalWindow,
        configurable: true,
        writable: true
      })
  }
})

test('a global subagent listing that crossed a deletion does not restore the thread', async () => {
  // Boot hydrates every thread's agents at once, and cancel/close degrade to a
  // global listing whenever the parent thread cannot be named. Neither passes a
  // threadId, so a guard on the argument never sees them.
  const listing: { resolve?: (snapshots: unknown[]) => void } = {}
  const globalScope = globalThis as typeof globalThis & { window?: unknown }
  const originalWindow = globalScope.window
  Object.defineProperty(globalScope, 'window', {
    value: {
      api: {
        yachiyo: {
          listSkills: async () => [],
          listThings: async () => [],
          cancelSubagent: async () => undefined,
          listSubagents: () =>
            new Promise((resolve) => {
              listing.resolve = resolve as (snapshots: unknown[]) => void
            })
        }
      }
    },
    configurable: true,
    writable: true
  })

  useAppStore.setState({
    activeThreadId: 'thread-20',
    messages: {},
    subagentSnapshotsById: {},
    subagentSnapshotIdsByThread: {},
    threads: [
      { id: 'thread-19', title: 'Doomed', updatedAt: TIMESTAMP },
      { id: 'thread-20', title: 'Kept', updatedAt: TIMESTAMP }
    ]
  })

  try {
    // No snapshot for this agent, so parentThreadId is undefined and the
    // listing widens to every thread.
    const cancelling = useAppStore.getState().cancelSubagent('agent-unknown')
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(listing.resolve, 'expected a subagent listing to be in flight')

    deleteThread('thread-19')
    listing.resolve([
      {
        agentId: 'agent-doomed',
        parentThreadId: 'thread-19',
        launchRunId: 'run-1',
        agentName: 'a',
        agentType: 'explore',
        codeName: 'x',
        workspacePath: '/tmp',
        state: 'completed',
        startedAt: TIMESTAMP,
        updatedAt: TIMESTAMP
      },
      {
        agentId: 'agent-kept',
        parentThreadId: 'thread-20',
        launchRunId: 'run-2',
        agentName: 'b',
        agentType: 'explore',
        codeName: 'y',
        workspacePath: '/tmp',
        state: 'completed',
        startedAt: TIMESTAMP,
        updatedAt: TIMESTAMP
      }
    ])
    await cancelling

    const state = useAppStore.getState()
    assert.equal(state.subagentSnapshotIdsByThread['thread-19'], undefined)
    assert.equal(state.subagentSnapshotsById['agent-doomed'], undefined)
    // The live thread in the same response is untouched.
    assert.ok(state.subagentSnapshotsById['agent-kept'])
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalScope, 'window')
    else
      Object.defineProperty(globalScope, 'window', {
        value: originalWindow,
        configurable: true,
        writable: true
      })
  }
})

test('deleting the open archived thread retires a jump aimed at it', () => {
  // The archived view switches activeArchivedThreadId and leaves the live
  // thread alone, so a rule that watches only the live thread never fires and
  // the intent follows the user to the next archived conversation.
  useAppStore.setState({
    activeThreadId: null,
    activeArchivedThreadId: 'archived-1',
    scrollToMessage: { threadId: 'archived-1', messageId: 'm' },
    messages: { 'archived-1': [] },
    threads: [],
    archivedThreads: [
      { id: 'archived-1', title: 'One', updatedAt: TIMESTAMP, archivedAt: TIMESTAMP },
      { id: 'archived-2', title: 'Two', updatedAt: TIMESTAMP, archivedAt: TIMESTAMP }
    ]
  })

  deleteThread('archived-1')

  assert.notEqual(useAppStore.getState().activeArchivedThreadId, 'archived-1')
  assert.equal(useAppStore.getState().scrollToMessage, null)
})

test('a plan document read that crossed a deletion is not written back', async () => {
  // The read was allowed to start because the thread was alive; the delete
  // lands while it is in flight and the response arrives afterwards.
  const plan: { resolve?: (document: { path: string; content: string }) => void } = {}
  const globalScope = globalThis as typeof globalThis & { window?: unknown }
  const originalWindow = globalScope.window
  Object.defineProperty(globalScope, 'window', {
    value: {
      api: {
        yachiyo: {
          listSkills: async () => [],
          listThings: async () => [],
          listSubagents: async () => [],
          loadThreadData: async () => ({
            messages: [],
            queuedFollowUpMessages: [],
            toolCalls: [
              {
                id: 'tool-exit-plan',
                runId: 'run-plan',
                threadId: 'thread-21',
                toolName: 'exitPlanMode',
                status: 'completed',
                inputSummary: 'ready=true',
                startedAt: TIMESTAMP,
                finishedAt: TIMESTAMP
              }
            ],
            runs: []
          }),
          readThreadPlanDocument: () =>
            new Promise((resolve) => {
              plan.resolve = resolve as (document: { path: string; content: string }) => void
            })
        }
      }
    },
    configurable: true,
    writable: true
  })

  useAppStore.setState({
    activeThreadId: null,
    messages: {},
    toolCalls: {},
    planDocumentsByThread: {},
    threads: [
      { id: 'thread-21', title: 'Doomed', updatedAt: TIMESTAMP },
      { id: 'thread-22', title: 'Kept', updatedAt: TIMESTAMP }
    ]
  })

  try {
    useAppStore.getState().setActiveThread('thread-21')
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(plan.resolve, 'expected a plan document read to be in flight')

    deleteThread('thread-21')
    plan.resolve({ path: '.yachiyo/plan.md', content: '# Plan' })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(useAppStore.getState().planDocumentsByThread['thread-21'], undefined)
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalScope, 'window')
    else
      Object.defineProperty(globalScope, 'window', {
        value: originalWindow,
        configurable: true,
        writable: true
      })
  }
})

test('a plan read from the tool event does not land after a deletion', () => {
  // The other three plan landings are the on-demand hydration, the boot batch,
  // and the message.completed branch; this is the tool.updated one.
  const plan: { resolve?: (document: { path: string; content: string }) => void } = {}
  const globalScope = globalThis as typeof globalThis & { window?: unknown }
  const originalWindow = globalScope.window
  Object.defineProperty(globalScope, 'window', {
    value: {
      api: {
        yachiyo: {
          listSkills: async () => [],
          listThings: async () => [],
          readThreadPlanDocument: () =>
            new Promise((resolve) => {
              plan.resolve = resolve as (document: { path: string; content: string }) => void
            })
        }
      }
    },
    configurable: true,
    writable: true
  })

  return (async () => {
    useAppStore.setState({
      activeThreadId: 'thread-23',
      planDocumentsByThread: {},
      messages: {},
      threads: [
        { id: 'thread-23', title: 'Doomed', updatedAt: TIMESTAMP },
        { id: 'thread-24', title: 'Kept', updatedAt: TIMESTAMP }
      ]
    })

    try {
      useAppStore.getState().applyServerEvent({
        type: 'tool.updated',
        eventId: 'event-tool',
        timestamp: TIMESTAMP,
        threadId: 'thread-23',
        toolCall: {
          id: 'tool-exit-plan',
          runId: 'run-plan',
          threadId: 'thread-23',
          toolName: 'exitPlanMode',
          status: 'completed',
          inputSummary: 'ready=true',
          startedAt: TIMESTAMP,
          finishedAt: TIMESTAMP
        }
      } as Parameters<ReturnType<typeof useAppStore.getState>['applyServerEvent']>[0])
      await new Promise((resolve) => setImmediate(resolve))
      assert.ok(plan.resolve, 'expected a plan read to be in flight')

      deleteThread('thread-23')
      plan.resolve({ path: '.yachiyo/plan.md', content: '# Plan' })
      await new Promise((resolve) => setImmediate(resolve))

      assert.equal(useAppStore.getState().planDocumentsByThread['thread-23'], undefined)
    } finally {
      if (originalWindow === undefined) Reflect.deleteProperty(globalScope, 'window')
      else
        Object.defineProperty(globalScope, 'window', {
          value: originalWindow,
          configurable: true,
          writable: true
        })
    }
  })()
})

test('the startup plan batch drops only the thread deleted while it was reading', () => {
  // Startup reads every pending plan in one batch. A guard on the batch as a
  // whole would either keep a deleted thread's plan or throw away the live
  // ones with it, so the filter has to be per entry.
  const plans: Record<string, (document: { path: string; content: string }) => void> = {}
  const globalScope = globalThis as typeof globalThis & { window?: unknown }
  const originalWindow = globalScope.window
  const planToolCall = (threadId: string): Record<string, string> => ({
    id: `tool-${threadId}`,
    runId: 'run-plan',
    threadId,
    toolName: 'exitPlanMode',
    status: 'completed',
    inputSummary: 'ready=true',
    startedAt: TIMESTAMP,
    finishedAt: TIMESTAMP
  })

  Object.defineProperty(globalScope, 'window', {
    value: {
      api: {
        yachiyo: {
          listSkills: async () => [],
          listThings: async () => [],
          listSubagents: async () => [],
          loadThreadData: async () => ({
            messages: [],
            queuedFollowUpMessages: [],
            toolCalls: [],
            runs: []
          }),
          subscribe: () => () => undefined,
          bootstrap: async () => ({
            threads: [
              { id: 'plan-doomed', title: 'Doomed', updatedAt: TIMESTAMP },
              { id: 'plan-live', title: 'Live', updatedAt: TIMESTAMP }
            ],
            archivedThreads: [],
            folders: [],
            messagesByThread: {},
            toolCallsByThread: {
              'plan-doomed': [planToolCall('plan-doomed')],
              'plan-live': [planToolCall('plan-live')]
            },
            latestRunsByThread: {},
            recoveredInterruptedSaveThreadIds: [],
            config: { enabledTools: DEFAULT_ENABLED_TOOL_NAMES, providers: [] },
            settings: {
              ...DEFAULT_SETTINGS,
              apiKey: 'sk-test',
              model: 'gpt-5',
              providerName: 'work'
            }
          }),
          readThreadPlanDocument: ({ threadId }: { threadId: string }) =>
            new Promise((resolve) => {
              plans[threadId] = resolve as (document: { path: string; content: string }) => void
            })
        }
      }
    },
    configurable: true,
    writable: true
  })

  return (async () => {
    try {
      // A previous test in this file already booted; the action short-circuits
      // while the store still says it is initialized.
      useAppStore.setState({ initialized: false, isBootstrapping: false })
      const booting = useAppStore.getState().initialize()
      for (let tick = 0; tick < 50 && !plans['plan-live']; tick++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      assert.ok(plans['plan-doomed'] && plans['plan-live'], 'expected both plan reads in flight')

      deleteThread('plan-doomed')
      plans['plan-doomed']({ path: 'a.md', content: '# A' })
      plans['plan-live']({ path: 'b.md', content: '# B' })
      await booting

      const state = useAppStore.getState()
      assert.equal(state.planDocumentsByThread['plan-doomed'], undefined)
      assert.ok(state.planDocumentsByThread['plan-live'])
    } finally {
      if (originalWindow === undefined) Reflect.deleteProperty(globalScope, 'window')
      else
        Object.defineProperty(globalScope, 'window', {
          value: originalWindow,
          configurable: true,
          writable: true
        })
    }
  })()
})
