import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseHTML } from 'linkedom'

import { useAppStore } from '@renderer/app/store/useAppStore'
import { AppDialogContext, type AppDialogApi } from '@renderer/components/AppDialogContext'
import type { Message, Thread } from '@renderer/app/types'

const THREAD_ID = 'thread-component-wiring'
const TIMESTAMP = '2026-09-03T00:00:00.000Z'

const dialog: AppDialogApi = {
  alert: async () => {},
  confirm: async () => false,
  prompt: async () => null
}

let MessageTimeline: typeof import('./MessageTimeline.tsx').MessageTimeline
let root: Root | null = null
let now = 1_000
let originalDateNow: typeof Date.now
let animationFrames: FrameRequestCallback[] = []

function installDom(): void {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  const globalScope = globalThis as typeof globalThis & Record<PropertyKey, unknown>

  const install = (key: PropertyKey, value: unknown): void => {
    Object.defineProperty(globalScope, key, {
      configurable: true,
      writable: true,
      value
    })
  }

  class TestResizeObserver {
    observe(): void {
      return
    }
    unobserve(): void {
      return
    }
    disconnect(): void {
      return
    }
  }

  Object.defineProperties(window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get: () => 0 },
    clientWidth: { configurable: true, get: () => 0 },
    scrollHeight: { configurable: true, get: () => 0 },
    scrollWidth: { configurable: true, get: () => 0 },
    scrollTo: { configurable: true, value: () => {} }
  })

  install('window', window)
  install('document', window.document)
  install('navigator', window.navigator)
  install('Element', window.Element)
  install('HTMLElement', window.HTMLElement)
  install('Node', window.Node)
  install('Event', window.Event)
  install('MutationObserver', window.MutationObserver)
  install('ResizeObserver', TestResizeObserver)
  install('getComputedStyle', () => ({ overflowX: 'visible', overflowY: 'visible' }))
  install('requestAnimationFrame', (callback: FrameRequestCallback) => {
    animationFrames.push(callback)
    return 1
  })
  install('cancelAnimationFrame', () => {})
  install('IS_REACT_ACT_ENVIRONMENT', true)
}

function createThread(): Thread {
  return {
    id: THREAD_ID,
    title: 'Component wiring',
    updatedAt: TIMESTAMP
  }
}

function createUserMessage(): Message {
  return {
    id: 'message-1',
    threadId: THREAD_ID,
    role: 'user',
    content: 'Hello',
    status: 'completed',
    createdAt: TIMESTAMP
  }
}

async function renderTimeline(): Promise<HTMLElement> {
  const container = document.querySelector<HTMLElement>('#root')
  assert.ok(container)
  root = createRoot(container)

  await act(async () => {
    root?.render(
      React.createElement(
        AppDialogContext.Provider,
        { value: dialog },
        React.createElement(MessageTimeline, {
          threadId: THREAD_ID,
          activeSurface: 'timeline',
          browserSessions: [],
          selectedBrowserSession: null
        })
      )
    )
  })

  return container
}

async function scrollTimeline(scrollTop: number): Promise<string[]> {
  const requestedThreadIds: string[] = []
  useAppStore.setState({
    threads: [createThread()],
    messages: { [THREAD_ID]: [createUserMessage()] },
    threadMessagePaging: {
      [THREAD_ID]: { hasOlder: true, loadingOlder: false }
    },
    loadOlderThreadMessages: async (threadId) => {
      requestedThreadIds.push(threadId)
    }
  })

  const container = await renderTimeline()
  const scrollContainer = container.querySelector<HTMLElement>('[data-timeline-scroll]')
  assert.ok(scrollContainer)
  Object.defineProperties(scrollContainer, {
    scrollTop: { configurable: true, writable: true, value: scrollTop },
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 300 }
  })
  now = 2_000

  await act(async () => {
    scrollContainer.dispatchEvent(new Event('scroll'))
  })

  return requestedThreadIds
}

before(async () => {
  installDom()
  originalDateNow = Date.now
  Date.now = () => now
  ;({ MessageTimeline } = await import('./MessageTimeline.tsx'))
})

beforeEach(() => {
  now = 1_000
  animationFrames = []
  useAppStore.setState(useAppStore.getInitialState(), true)
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount())
    root = null
  }
  useAppStore.setState(useAppStore.getInitialState(), true)
})

after(() => {
  Date.now = originalDateNow
})

test('an empty loaded timeline retires a missing scroll target', async () => {
  useAppStore.setState({
    threads: [createThread()],
    messages: { [THREAD_ID]: [] },
    threadMessagePaging: {
      [THREAD_ID]: { hasOlder: false, loadingOlder: false }
    },
    scrollToMessage: { threadId: THREAD_ID, messageId: 'missing-message' }
  })

  await renderTimeline()

  assert.equal(useAppStore.getState().scrollToMessage, null)
})

test('an empty timeline that has not loaded yet keeps its scroll target', async () => {
  useAppStore.setState({
    threads: [createThread()],
    messages: {},
    scrollToMessage: { threadId: THREAD_ID, messageId: 'not-loaded-yet' }
  })

  await renderTimeline()

  assert.deepEqual(useAppStore.getState().scrollToMessage, {
    threadId: THREAD_ID,
    messageId: 'not-loaded-yet'
  })
})

test('scrolling the timeline near the top requests the previous page', async () => {
  assert.deepEqual(await scrollTimeline(399), [THREAD_ID])
})

test('scrolling the timeline away from the top does not request the previous page', async () => {
  assert.deepEqual(await scrollTimeline(600), [])
})

async function loadHistoryAtViewport(): Promise<{
  container: HTMLElement
  frame: () => Promise<void>
  setInsertedHeight: (height: number) => void
}> {
  let requests = 0
  const latestMessage = { ...createUserMessage(), parentMessageId: 'older-message' }
  useAppStore.setState({
    threads: [createThread()],
    messages: { [THREAD_ID]: [latestMessage] },
    threadMessagePaging: { [THREAD_ID]: { hasOlder: true, loadingOlder: false } },
    loadOlderThreadMessages: async () => {
      requests++
    }
  })
  const rootElement = await renderTimeline()
  const container = rootElement.querySelector<HTMLElement>('[data-timeline-scroll]')!
  let insertedHeight = 0
  Object.defineProperties(container, {
    scrollTop: { configurable: true, writable: true, value: 300 },
    scrollHeight: { configurable: true, get: () => 720 + insertedHeight },
    clientHeight: { configurable: true, value: 400 },
    scrollTo: {
      configurable: true,
      value: (options: ScrollToOptions) => {
        container.scrollTop = options.top ?? container.scrollTop
      }
    }
  })
  container.getBoundingClientRect = () => ({ top: 50 }) as DOMRect
  // linkedom has no layout; model the measured position of the actual visible row.
  const row = document.createElement('div')
  row.dataset.timelineRowKey = 'user:message-1'
  row.getBoundingClientRect = () =>
    ({
      top: 330 + insertedHeight - container.scrollTop,
      bottom: 430 + insertedHeight - container.scrollTop
    }) as DOMRect
  container.appendChild(row)
  now = 2_000
  await act(async () => container.dispatchEvent(new Event('scroll')))
  assert.equal(requests, 1)
  insertedHeight = 1_000
  await act(async () => {
    useAppStore.setState({
      messages: {
        [THREAD_ID]: [
          { ...createUserMessage(), id: 'older-message', createdAt: '2026-09-02T00:00:00.000Z' },
          latestMessage
        ]
      }
    })
  })
  const frame = async (): Promise<void> => {
    const callbacks = animationFrames
    animationFrames = []
    await act(async () => {
      for (const callback of callbacks) callback(now)
    })
  }
  await frame()
  assert.equal(container.scrollTop, 1_300)
  return {
    container,
    frame,
    setInsertedHeight: (height) => {
      insertedHeight = height
    }
  }
}

test('loading history retains the visible DOM anchor after prepend and measured height changes', async () => {
  const { container, frame, setInsertedHeight } = await loadHistoryAtViewport()
  setInsertedHeight(1_360)
  await frame()
  assert.equal(container.scrollTop, 1_660)
  await frame()
  await frame()
  assert.equal(container.scrollTop, 1_660)
})

test('sending a message cancels a pending history anchor correction', async () => {
  const { container, frame, setInsertedHeight } = await loadHistoryAtViewport()
  await act(async () => {
    useAppStore.setState({ activeRequestMessageIdsByThread: { [THREAD_ID]: 'new-request' } })
  })
  setInsertedHeight(1_360)
  await frame()
  await frame()
  await frame()
  assert.notEqual(
    container.scrollTop,
    1_660,
    'history must not pull the viewport back to the old row'
  )
})
