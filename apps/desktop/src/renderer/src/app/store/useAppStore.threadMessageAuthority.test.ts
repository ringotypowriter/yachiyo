import type { YachiyoPreloadYachiyoApi } from '../../../../preload/index.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { useAppStore } from './useAppStore.ts'

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
  install: () => () => void
  settle: (data: Partial<ThreadData>) => Promise<void>
  planDocumentReads: () => number
} {
  let resolveRead: ((data: ThreadData) => void) | null = null
  let planDocumentReads = 0
  const globalScope = globalThis as typeof globalThis & { window?: unknown }
  let originalWindow: unknown

  return {
    install: () => {
      originalWindow = globalScope.window
      Object.defineProperty(globalScope, 'window', {
        value: {
          api: {
            yachiyo: {
              listSkills: async () => [],
              listThings: async () => [],
              loadThreadData: () =>
                new Promise<ThreadData>((resolve) => {
                  resolveRead = resolve
                }),
              readThreadPlanDocument: async () => {
                planDocumentReads += 1
                return { path: '.yachiyo/plan.md', content: '# Plan' }
              }
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
