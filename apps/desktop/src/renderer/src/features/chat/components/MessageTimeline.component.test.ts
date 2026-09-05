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
