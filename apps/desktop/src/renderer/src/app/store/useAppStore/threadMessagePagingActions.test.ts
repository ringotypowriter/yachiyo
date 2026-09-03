import assert from 'node:assert/strict'
import test from 'node:test'

import type { Message } from '../../types.ts'
import type { AppState } from '../useAppStore.ts'
import { createThreadMessagePagingActions } from './threadMessagePagingActions.ts'

function message(id: string): Message {
  return { id, role: 'user', content: id } as Message
}

function ids(messages: Message[] | undefined): string[] {
  return (messages ?? []).map((entry) => entry.id)
}

type LoadCall = { threadId: string; beforeMessageId?: string }

/**
 * A store stub with only the slices this action reads and writes, plus a
 * hand-controlled loadThreadData so a page can be left in flight while the
 * rest of the app moves on.
 */
function harness(initial: {
  messages: Record<string, Message[]>
  threadMessagePaging: AppState['threadMessagePaging']
}): {
  getState: () => AppState
  setMessages: (messages: Record<string, Message[]>) => void
  loadOlderThreadMessages: (threadId: string) => Promise<void>
  calls: LoadCall[]
  settle: (result: { messages: Message[] } | Error) => Promise<void>
  restoreWindow: () => void
} {
  let state = { ...initial } as AppState
  const get = (): AppState => state
  const set = (partial: Partial<AppState> | ((current: AppState) => Partial<AppState>)): void => {
    const next = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...next }
  }

  const calls: LoadCall[] = []
  let pending: {
    resolve: (value: { messages: Message[] }) => void
    reject: (reason: Error) => void
  } | null = null

  const globalScope = globalThis as typeof globalThis & { window?: unknown }
  const originalWindow = globalScope.window
  Object.defineProperty(globalScope, 'window', {
    value: {
      api: {
        yachiyo: {
          loadThreadData: (input: LoadCall) => {
            calls.push(input)
            return new Promise<{ messages: Message[] }>((resolve, reject) => {
              pending = { resolve, reject }
            })
          }
        }
      }
    },
    configurable: true,
    writable: true
  })

  const actions = createThreadMessagePagingActions({ set, get })

  return {
    getState: get,
    setMessages: (messages) => set({ messages } as Partial<AppState>),
    loadOlderThreadMessages: actions.loadOlderThreadMessages,
    calls,
    settle: async (result) => {
      assert.ok(pending, 'expected a page to be in flight')
      if (result instanceof Error) pending.reject(result)
      else pending.resolve(result)
      // Let the action's continuation run before assertions.
      await new Promise((resolve) => setImmediate(resolve))
    },
    restoreWindow: () => {
      if (originalWindow === undefined) Reflect.deleteProperty(globalScope, 'window')
      else
        Object.defineProperty(globalScope, 'window', {
          value: originalWindow,
          configurable: true,
          writable: true
        })
    }
  }
}

test('a page in flight for one thread lands on that thread, not on the one now open', async () => {
  // The reader scrolls up in thread A, then switches to B before the page
  // arrives. Keying the fold by the requested thread is what keeps A's older
  // messages out of B's timeline.
  const store = harness({
    messages: { a: [message('a3')], b: [message('b9')] },
    threadMessagePaging: {
      a: { hasOlder: true, loadingOlder: false },
      b: { hasOlder: true, loadingOlder: false }
    }
  })

  const inFlight = store.loadOlderThreadMessages('a')
  store.setMessages({ a: [message('a3')], b: [message('b9')] })

  // While A's page is in flight, B must still look scrollable — a shared
  // in-flight flag would freeze the thread the reader is actually looking at.
  assert.deepEqual(store.getState().threadMessagePaging.b, {
    hasOlder: true,
    loadingOlder: false
  })

  await store.settle({ messages: [message('a1'), message('a2')] })
  await inFlight

  assert.deepEqual(ids(store.getState().messages.a), ['a1', 'a2', 'a3'])
  assert.deepEqual(ids(store.getState().messages.b), ['b9'])
  assert.deepEqual(store.getState().threadMessagePaging.b, {
    hasOlder: true,
    loadingOlder: false
  })
  store.restoreWindow()
})

test('a page for a thread dropped from memory is discarded rather than resurrected', async () => {
  // Folding a page into an evicted thread would leave a thread whose timeline
  // holds only its oldest slice — a partial history presented as the whole.
  const store = harness({
    messages: { a: [message('a3')] },
    threadMessagePaging: { a: { hasOlder: true, loadingOlder: false } }
  })

  const inFlight = store.loadOlderThreadMessages('a')
  store.setMessages({})
  await store.settle({ messages: [message('a1'), message('a2')] })
  await inFlight

  assert.equal(store.getState().messages.a, undefined)
  // Not merely "a is absent" — a crash inside the fold would look identical
  // from the outside. The paging entry going with it is what distinguishes a
  // deliberate discard, and it keeps a reopened thread from inheriting a
  // stuck in-flight flag.
  assert.equal(store.getState().threadMessagePaging.a, undefined)
})

test('a failed page stays retryable instead of reporting the thread fully loaded', async () => {
  const store = harness({
    messages: { a: [message('a3')] },
    threadMessagePaging: { a: { hasOlder: true, loadingOlder: false } }
  })

  const inFlight = store.loadOlderThreadMessages('a')
  await store.settle(new Error('ipc down'))
  await inFlight

  assert.deepEqual(store.getState().threadMessagePaging.a, { hasOlder: true, loadingOlder: false })
  assert.deepEqual(ids(store.getState().messages.a), ['a3'])

  // Retry eligibility means the next scroll actually issues a read.
  void store.loadOlderThreadMessages('a')
  assert.equal(store.calls.length, 2)
  store.restoreWindow()
})

test('scrolling again while a page is in flight does not issue a second read', async () => {
  const store = harness({
    messages: { a: [message('a3')] },
    threadMessagePaging: { a: { hasOlder: true, loadingOlder: false } }
  })

  const inFlight = store.loadOlderThreadMessages('a')
  await store.loadOlderThreadMessages('a')

  assert.equal(store.calls.length, 1)
  await store.settle({ messages: [message('a2')] })
  await inFlight
  store.restoreWindow()
})

test('the cursor is the oldest loaded message, so a page never repeats what is shown', async () => {
  const store = harness({
    messages: { a: [message('a3'), message('a4')] },
    threadMessagePaging: { a: { hasOlder: true, loadingOlder: false } }
  })

  const inFlight = store.loadOlderThreadMessages('a')

  assert.equal(store.calls[0]?.beforeMessageId, 'a3')
  await store.settle({ messages: [message('a2')] })
  await inFlight
  store.restoreWindow()
})

test('a short page ends the thread, so the reader is not offered more that will never come', async () => {
  const store = harness({
    messages: { a: [message('a3')] },
    threadMessagePaging: { a: { hasOlder: true, loadingOlder: false } }
  })

  const inFlight = store.loadOlderThreadMessages('a')
  await store.settle({ messages: [message('a2')] })
  await inFlight

  assert.deepEqual(store.getState().threadMessagePaging.a, { hasOlder: false, loadingOlder: false })
  store.restoreWindow()
})
