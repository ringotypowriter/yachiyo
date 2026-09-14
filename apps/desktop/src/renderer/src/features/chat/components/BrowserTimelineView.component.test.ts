import assert from 'node:assert/strict'
import { afterEach, before, beforeEach, test } from 'node:test'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseHTML } from 'linkedom'

let BrowserTimelineView: typeof import('./BrowserTimelineView.tsx').BrowserTimelineView
let root: Root | null = null

type Session = { threadId: string; session: string }
type Request = Session & { resolve: () => void; reject: (error: Error) => void }
let shows: Request[] = []
let bounds: Request[] = []
let hides: Session[] = []

function pendingRequest(input: Session, requests: Request[]): Promise<void> {
  return new Promise((resolve, reject) => {
    requests.push({ threadId: input.threadId, session: input.session, resolve, reject })
  })
}

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
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  Object.defineProperty(window, 'api', {
    value: {
      yachiyo: {
        showBrowserAutomationSession: (input: Session) => pendingRequest(input, shows),
        setBrowserAutomationSessionBounds: (input: Session) => pendingRequest(input, bounds),
        hideBrowserAutomationSession: async (input: Session) => {
          hides.push(input)
        }
      }
    }
  })
  ;({ BrowserTimelineView } = await import('./BrowserTimelineView.tsx'))
})

beforeEach(() => {
  shows = []
  bounds = []
  hides = []
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.querySelector('#root')!)
})

afterEach(async () => {
  await unmount()
})

async function render(
  props: Partial<React.ComponentProps<typeof BrowserTimelineView>> = {}
): Promise<void> {
  await act(async () => {
    root?.render(
      React.createElement(BrowserTimelineView, {
        threadId: 'thread-1',
        sessionId: 'session-1',
        ...props
      })
    )
  })
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount())
  root = null
}

const firstSession = { threadId: 'thread-1', session: 'session-1' }
const secondSession = { threadId: 'thread-1', session: 'session-2' }

test('unmount hides a requested session before show or bounds settles', async () => {
  await render()
  assert.equal(shows.length, 1)
  assert.equal(bounds.length, 1)

  await unmount()
  assert.deepEqual(hides, [firstSession])
  await act(async () => {
    shows[0].resolve()
    bounds[0].resolve()
  })
  assert.deepEqual(hides, [firstSession])
})

for (const props of [{ suspended: true }, { sessionPickerOpen: true }]) {
  test(`${Object.keys(props)[0]} hides a requested session before show settles`, async () => {
    await render()
    await render(props)
    assert.deepEqual(hides, [firstSession])

    await act(async () => {
      shows[0].resolve()
      bounds[0].resolve()
    })
    await unmount()
    assert.deepEqual(hides, [firstSession])
  })
}

for (const outcome of ['resolve', 'reject'] as const) {
  test(`old session ${outcome} callbacks cannot hide or claim the new session`, async () => {
    await render()
    await render({ sessionId: 'session-2' })
    assert.equal(shows.length, 2)
    assert.deepEqual(hides, [firstSession])

    await act(async () => {
      shows[1].resolve()
      bounds[1].resolve()
    })
    await act(async () => {
      if (outcome === 'resolve') {
        shows[0].resolve()
        bounds[0].resolve()
      } else {
        shows[0].reject(new Error('old show failed'))
        bounds[0].reject(new Error('old bounds failed'))
      }
    })
    assert.deepEqual(hides, [firstSession])
    assert.equal(document.querySelector('.browser-timeline-view__error'), null)
    await unmount()
    assert.deepEqual(hides, [firstSession, secondSession])
  })
}
