import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { AppDialogContext } from '@renderer/components/AppDialogContext'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { ContentReaderStage } from './ContentReaderStage'
import { ContentReaderTabs } from './ContentReaderTabs'
import { useContentReaderStore } from '../state/useContentReaderStore'

test('opening a document covers but does not unmount the conversation or composer and returns to its reading position', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    ResizeObserver: class {
      observe(): void {
        return
      }
      disconnect(): void {
        return
      }
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  }
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  let nativePage = {
    threadId: 'a',
    session: 'native-preview',
    url: 'https://example.com/a',
    title: 'Page A'
  }
  const externalUrls: string[] = []
  let nativePresent = true
  const restores: unknown[] = []
  Object.assign(window, {
    open: (url: string) => {
      externalUrls.push(url)
    },
    api: {
      yachiyo: {
        listBrowserAutomationSessions: async () => (nativePresent ? [nativePage] : []),
        openBrowserPreview: async (input: unknown) => {
          restores.push(input)
          nativePresent = true
          return nativePage
        },
        showBrowserAutomationSession: async () => nativePage,
        setBrowserAutomationSessionBounds: async () => nativePage,
        hideBrowserAutomationSession: async () => {},
        readFilePreview: async () => ({
          kind: 'text',
          path: '/work/report.txt',
          content: 'A readable report'
        }),
        getSnapshotDiff: async () => [
          { relativePath: 'settings.ts', status: 'modified', diff: '-old\n+new' },
          { relativePath: 'reader.ts', status: 'created', diff: '+reader' }
        ]
      }
    }
  })
  useContentReaderStore.getState().close()
  useAppStore.setState({ latestRunsByThread: {}, activeRunIdsByThread: {} })
  const root = createRoot(document.getElementById('root')!)
  let mounts = 0
  let unmounts = 0
  function Conversation(): React.JSX.Element {
    React.useEffect(() => {
      mounts++
      return () => {
        unmounts++
      }
    }, [])
    return React.createElement(
      'div',
      {
        'data-timeline-scroll': true,
        ref: (element: HTMLDivElement | null) => {
          if (element) element.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
        }
      },
      'Original conversation'
    )
  }
  // Mirrors the app header: tabs replace the title and the active preview portals its tools.
  function Header({ threadId }: { threadId: string }): React.JSX.Element {
    const [toolsHost, setToolsHost] = React.useState<HTMLDivElement | null>(null)
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(ContentReaderTabs, { threadId }),
      React.createElement('div', { ref: setToolsHost, 'data-reader-tools': true }),
      React.createElement(
        ContentReaderStage,
        { threadId, toolsHost },
        React.createElement(Conversation)
      )
    )
  }
  const renderStage = (threadId: string): void => {
    root.render(
      React.createElement(
        AppDialogContext.Provider,
        {
          value: { alert: async () => {}, confirm: async () => false, prompt: async () => null }
        },
        React.createElement(Header, { threadId }),
        React.createElement('textarea', { 'data-composer': true, defaultValue: 'Keep my draft' })
      )
    )
  }
  try {
    await act(async () => renderStage('a'))
    const timeline = document.querySelector<HTMLElement>('[data-timeline-scroll]')!
    const composer = document.querySelector<HTMLTextAreaElement>('[data-composer]')!
    composer.value = 'Keep my draft'
    timeline.scrollTop = 240
    await act(async () => {
      useContentReaderStore
        .getState()
        .open({ kind: 'file', threadId: 'a', workspacePath: '/work', path: '/work/report.txt' })
    })
    assert.equal(
      document.querySelector('.content-reader-conversation')?.getAttribute('data-covered'),
      'true'
    )
    assert.match(document.querySelector('.content-reader')?.textContent ?? '', /A readable report/)
    assert.equal(document.querySelector('[data-composer]'), composer)
    assert.equal(composer.value, 'Keep my draft')
    assert.equal(mounts, 1)
    assert.equal(unmounts, 0)
    timeline.scrollTop = 900
    await act(async () => {
      useContentReaderStore.getState().close()
    })
    assert.equal(document.querySelector('.content-reader'), null)
    assert.equal(document.querySelector('[data-timeline-scroll]'), timeline)
    assert.equal(timeline.scrollTop, 240)
    assert.equal(unmounts, 0)
    await act(async () => {
      useContentReaderStore
        .getState()
        .open({ kind: 'image', threadId: 'a', src: 'data:image/png;base64,AAAA', alt: 'Cover' })
    })
    assert.ok(document.querySelector('.content-reader [data-image]'))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click()
    })
    assert.match(
      (document.querySelector('[data-image]') as HTMLElement).style.transform,
      /scale\(1\.15\)/
    )
    await act(async () => {
      useContentReaderStore
        .getState()
        .open({ kind: 'diff', threadId: 'a', runId: 'review-run', workspacePath: '/work' })
    })
    assert.ok(document.querySelector('.content-reader-diff'))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    const diffTarget = useContentReaderStore.getState().target
    assert.equal(diffTarget?.kind === 'diff' ? diffTarget.relativePath : null, 'settings.ts')
    const picker = document.querySelector<HTMLDetailsElement>('.content-reader-file-picker')
    assert.ok(picker)
    const diffScroller = document.querySelector<HTMLElement>(
      '.content-reader-diff__code .overflow-auto'
    )!
    const diffId = useContentReaderStore.getState().conversations.a.activeId
    await act(async () => {
      diffScroller.scrollTop = 230
      diffScroller.scrollLeft = 40
      diffScroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    })
    assert.equal(
      useContentReaderStore.getState().conversations.a.tabs.find((tab) => tab.id === diffId)!
        .reading.scrollTop,
      230
    )
    picker.setAttribute('open', '')
    await act(async () => {
      picker.querySelectorAll<HTMLButtonElement>('button')[1]!.click()
    })
    const selectedTarget = useContentReaderStore.getState().target
    assert.equal(selectedTarget?.kind === 'diff' ? selectedTarget.relativePath : null, 'reader.ts')
    assert.deepEqual(
      useContentReaderStore.getState().conversations.a.tabs.find((tab) => tab.id === diffId)!
        .reading,
      { diffPath: 'reader.ts', scrollTop: 0, scrollLeft: 0 }
    )
    assert.equal(picker.hasAttribute('open'), false)
    assert.equal(unmounts, 0)
    const image = document.querySelector('[data-image]') as HTMLElement
    const diff = document.querySelector('.content-reader-diff')!
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-reader-tools] [aria-label="Ask Yachiyo"]')!
        .click()
    })
    assert.equal(useContentReaderStore.getState().conversations.a.activeId, 'chat')
    assert.deepEqual(useContentReaderStore.getState().references.a, selectedTarget)
    assert.equal(composer.value, 'Keep my draft')
    await act(async () => {
      const imageTab = useContentReaderStore
        .getState()
        .conversations.a.tabs.find((tab) => tab.target.kind === 'image')!
      useContentReaderStore.getState().select('a', imageTab.id)
    })
    assert.equal(document.querySelector('[data-image]'), image)
    assert.match(image.style.transform, /scale\(1\.15\)/)
    assert.ok(diff.closest('section')?.hasAttribute('inert'))
    await act(async () => useContentReaderStore.getState().select('a', 'chat'))
    assert.ok(image.closest('section')?.hasAttribute('inert'))
    assert.equal(document.querySelectorAll('[role="tab"]')[0].textContent, 'Chat')
    assert.equal(composer.value, 'Keep my draft')
    assert.equal(unmounts, 0)
    await act(async () => renderStage('b'))
    assert.equal(document.querySelector('[data-image]'), image)
    assert.ok(image.closest('section')?.hasAttribute('inert'))
    assert.equal(document.querySelector('[role="tablist"]'), null)
    await act(async () => renderStage('a'))
    await act(async () => {
      const imageTab = useContentReaderStore
        .getState()
        .conversations.a.tabs.find((tab) => tab.target.kind === 'image')!
      useContentReaderStore.getState().select('a', imageTab.id)
    })
    assert.equal(document.querySelector('[data-image]'), image)
    assert.match(image.style.transform, /scale\(1\.15\)/)
    assert.equal(composer.value, 'Keep my draft')
    await act(async () => useContentReaderStore.getState().open({ kind: 'web', ...nativePage }))
    const webId = useContentReaderStore.getState().conversations.a.activeId
    nativePage = { ...nativePage, url: 'https://example.com/b', title: 'Page B' }
    await act(async () => {
      document
        .querySelector<HTMLElement>('[data-reader-tools] [aria-label="Open in browser"]')!
        .click()
    })
    assert.deepEqual(externalUrls, ['https://example.com/b'])
    assert.equal(useContentReaderStore.getState().conversations.a.activeId, webId)
    assert.match(
      document.querySelector('[role="tab"][aria-selected="true"]')!.textContent!,
      /Page B/
    )
    nativePage = { ...nativePage, url: 'https://example.com/c', title: 'Page C' }
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-reader-tools] [aria-label="Ask Yachiyo"]')!
        .click()
    })
    const webReference = useContentReaderStore.getState().references.a
    assert.equal(webReference.kind === 'web' && webReference.url, 'https://example.com/c')
    assert.equal(useContentReaderStore.getState().conversations.a.activeId, 'chat')
    assert.equal(composer.value, 'Keep my draft')
    await act(async () => {
      await useContentReaderStore.getState().discardIdle(Date.now() + 300001, async () => {
        nativePresent = false
        return {
          released: true,
          url: nativePage.url,
          title: nativePage.title,
          reading: { webScrollY: 123, webZoom: 1.25 }
        }
      })
    })
    assert.equal(document.querySelector('[data-image]'), null)
    assert.equal(document.querySelector('.content-reader-diff'), null)
    const imageDescriptor = useContentReaderStore
      .getState()
      .conversations.a.tabs.find((tab) => tab.target.kind === 'image')!
    assert.equal(imageDescriptor.hot, false)
    await act(async () => useContentReaderStore.getState().select('a', imageDescriptor.id))
    const restoredImage = document.querySelector('[data-image]') as HTMLElement
    assert.notEqual(restoredImage, image)
    assert.match(restoredImage.style.transform, /scale\(1\.15\)/)
    assert.equal(document.querySelector('.content-reader-diff'), null)
    const diffDescriptor = useContentReaderStore
      .getState()
      .conversations.a.tabs.find((tab) => tab.target.kind === 'diff')!
    await act(async () => useContentReaderStore.getState().select('a', diffDescriptor.id))
    const restoredDiffTarget = useContentReaderStore.getState().target
    assert.equal(
      restoredDiffTarget?.kind === 'diff' && restoredDiffTarget.relativePath,
      'reader.ts'
    )
    assert.equal(composer.value, 'Keep my draft')
    assert.equal(unmounts, 0)
    await act(async () => useContentReaderStore.getState().select('a', webId))
    assert.deepEqual(restores, [
      {
        threadId: 'a',
        session: 'native-preview',
        url: 'https://example.com/c',
        reading: { webScrollY: 123, webZoom: 1.25 }
      }
    ])
    assert.equal(composer.value, 'Keep my draft')
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
