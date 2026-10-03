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
let controls: Array<Session & { action: string; url?: string }> = []
let deferLists = false
let pendingLists: Array<{
  resolve: (records: typeof availableSessions) => void
  records: typeof availableSessions
}> = []
let availableSessions: Array<
  Session & {
    url: string
    viewport: { width: number; height: number }
    updatedAt: string
    controlledBy: 'agent'
    canGoBack: boolean
    dialog?: { type: string; message: string }
  }
> = []

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
        showBrowserAutomationSession: (input: Session) => pendingRequest(input, shows),
        setBrowserAutomationSessionBounds: (input: Session) => pendingRequest(input, bounds),
        hideBrowserAutomationSession: async (input: Session) => {
          hides.push(input)
        },
        listBrowserAutomationSessions: () =>
          deferLists
            ? new Promise<typeof availableSessions>((resolve) => {
                pendingLists.push({ resolve, records: availableSessions })
              })
            : Promise.resolve(availableSessions),
        controlBrowserAutomationSession: async (
          input: Session & { action: string; url?: string }
        ) => {
          controls.push(input)
          if (input.action === 'close') {
            availableSessions = availableSessions.filter((entry) => entry.session !== input.session)
          }
          return {
            ...input,
            url: input.url ?? 'https://example.com/current',
            viewport: { width: 800, height: 600 },
            updatedAt: '',
            controlledBy: input.action === 'takeOver' ? 'user' : 'agent'
          }
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
  controls = []
  deferLists = false
  pendingLists = []
  availableSessions = [
    {
      ...firstSession,
      url: 'https://example.com/current',
      viewport: { width: 800, height: 600 },
      updatedAt: '',
      controlledBy: 'agent',
      canGoBack: true
    }
  ]
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

test('a session reopened after closing its only tab becomes visible again', async () => {
  await render()
  const reopenedSession = availableSessions[0]
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Close tab"]')!.click()
  })
  assert.ok(document.querySelector('.browser-timeline-view--empty'))
  availableSessions = [reopenedSession]
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100))
  })
  assert.equal(document.querySelector('.browser-timeline-view--empty'), null)
  assert.equal(shows.at(-1)?.session, firstSession.session)
})

test('a list request started before close cannot resurrect the closed tab', async () => {
  deferLists = true
  await render()
  assert.equal(pendingLists.length, 1)
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Close tab"]')!.click()
  })
  assert.ok(document.querySelector('.browser-timeline-view--empty'))
  await act(async () => {
    const stale = pendingLists.shift()!
    stale.resolve(stale.records)
  })
  assert.ok(document.querySelector('.browser-timeline-view--empty'))
  assert.equal(shows.length, 1)
})

test('tab picker parks native page before floating selector opens', async () => {
  availableSessions.push({
    ...secondSession,
    url: 'https://example.com/new',
    viewport: { width: 800, height: 600 },
    updatedAt: '',
    controlledBy: 'agent',
    canGoBack: false
  })
  await render()
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Browser tabs"]')!
  await act(async () => {
    trigger.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
    trigger.click()
  })
  assert.deepEqual(hides, [firstSession])
  assert.ok(document.querySelector('.browser-timeline-view__picker-placeholder'))
})

test('toolbar uses live address and delegates navigation and take over to backend', async () => {
  await render()
  assert.equal(
    document.querySelector<HTMLInputElement>('[aria-label="Page address"]')?.value,
    'https://example.com/current'
  )
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    document.querySelector<HTMLButtonElement>('[aria-label="Take over"]')?.click()
  })
  assert.deepEqual(
    controls.map(({ action }) => action),
    ['back', 'takeOver']
  )
  assert.ok(document.querySelector('[aria-label="Resume"]'))
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Resume"]')?.click()
  })
  assert.equal(controls.at(-1)?.action, 'resume')
})

test('expanding browser keeps the same native viewport mounted', async () => {
  await render()
  const viewport = document.querySelector('.browser-timeline-view__viewport')
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Expand browser"]')?.click()
  })
  assert.ok(document.querySelector('.browser-timeline-view--expanded'))
  assert.equal(document.querySelector('.browser-timeline-view__viewport'), viewport)
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Restore browser"]')?.click()
  })
  assert.equal(document.querySelector('.browser-timeline-view__viewport'), viewport)
})

test('page dialog response delegates to backend instead of simulating DOM input', async () => {
  availableSessions[0].dialog = { type: 'confirm', message: 'Continue?' }
  await render()
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Continue\?/)
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[role="alert"] button')?.click()
  })
  assert.equal(controls[0]?.action, 'acceptDialog')
})

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
