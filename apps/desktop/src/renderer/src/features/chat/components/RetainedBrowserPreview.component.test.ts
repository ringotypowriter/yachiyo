import assert from 'node:assert/strict'
import { afterEach, before, beforeEach, test } from 'node:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseHTML } from 'linkedom'

import type { RetainedBrowserPreview as PreviewType } from './RetainedBrowserPreview'

let RetainedBrowserPreview: typeof PreviewType
let root: Root | null = null
const target = {
  kind: 'web' as const,
  threadId: 'thread-1',
  session: 'session-1',
  url: 'https://example.com/page',
  title: 'Page'
}
const session = {
  threadId: target.threadId,
  session: target.session,
  url: target.url,
  viewport: { width: 800, height: 600 },
  updatedAt: '',
  controlledBy: 'agent' as const
}
let present = true
let deferred = false
let pending: Array<(sessions: (typeof session)[]) => void> = []
let restoreError: Error | null = null
let restores: unknown[] = []

before(async () => {
  const { window } = parseHTML('<html><body></body></html>')
  class TestResizeObserver {
    observe(): void {
      return
    }
    disconnect(): void {
      return
    }
  }
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    ResizeObserver: TestResizeObserver,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    },
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  window.innerWidth = 1200
  window.innerHeight = 800
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 160,
    bottom: 32,
    width: 160,
    height: 32,
    x: 0,
    y: 0,
    toJSON: () => ({})
  })
  Object.defineProperty(window, 'api', {
    value: {
      yachiyo: {
        listBrowserAutomationSessions: () =>
          deferred
            ? new Promise<(typeof session)[]>((resolve) => {
                pending.push(resolve)
              })
            : Promise.resolve(present ? [session] : []),
        openBrowserPreview: async (input: unknown) => {
          restores.push(input)
          if (restoreError) throw restoreError
          present = true
          return session
        },
        showBrowserAutomationSession: async () => session,
        setBrowserAutomationSessionBounds: async () => session,
        hideBrowserAutomationSession: async () => {}
      }
    }
  })
  ;({ RetainedBrowserPreview } = await import('./RetainedBrowserPreview.tsx'))
})

beforeEach(() => {
  present = true
  deferred = false
  pending = []
  restoreError = null
  restores = []
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.querySelector('#root')!)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
})

async function render(suspended = false): Promise<void> {
  await act(async () => {
    root?.render(
      React.createElement(RetainedBrowserPreview, {
        target,
        reading: { webScrollY: 42 },
        suspended
      })
    )
  })
}

test('ready preview keeps the same timeline and local page state while resume health check is pending', async () => {
  await render()
  const timeline = document.querySelector<HTMLElement>('.browser-timeline-view')!
  assert.ok(timeline)
  timeline.scrollTop = 135
  await render(true)
  deferred = true
  await render(false)
  assert.ok(pending.length >= 1, 'resume must check if the native session still exists')
  assert.equal(document.querySelector('.browser-timeline-view'), timeline)
  assert.equal(timeline.scrollTop, 135)
  assert.doesNotMatch(document.body.textContent ?? '', /Loading web page/)
  await act(async () => {
    for (const resolve of pending.splice(0)) resolve([session])
  })
  assert.equal(document.querySelector('.browser-timeline-view'), timeline)
  assert.equal(restores.length, 0)
})

test('a missing native session is restored after resume and a failed restore can be retried', async () => {
  await render()
  await render(true)
  present = false
  restoreError = new Error('Restore failed')
  await render(false)
  assert.equal(document.querySelector('.browser-timeline-view'), null)
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Restore failed/)
  assert.equal(restores.length, 1)
  restoreError = null
  await act(async () => {
    document.querySelector<HTMLButtonElement>('button')!.click()
  })
  assert.ok(document.querySelector('.browser-timeline-view'))
  assert.equal(restores.length, 2)
  assert.deepEqual(restores[1], {
    threadId: target.threadId,
    session: target.session,
    url: target.url,
    reading: { webScrollY: 42 }
  })
})
