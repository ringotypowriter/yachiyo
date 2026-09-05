import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { AppDialogContext } from '@renderer/components/AppDialogContext'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { ContentReaderStage } from './ContentReaderStage'
import { useContentReaderStore } from '../state/useContentReaderStore'

test('opening a document covers but does not unmount the conversation or composer and returns to its reading position', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  }
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  Object.assign(window, {
    api: {
      yachiyo: {
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
  try {
    await act(async () => {
      root.render(
        React.createElement(
          AppDialogContext.Provider,
          {
            value: { alert: async () => {}, confirm: async () => false, prompt: async () => null }
          },
          React.createElement(
            ContentReaderStage,
            { threadId: 'a' },
            React.createElement(Conversation)
          ),
          React.createElement('textarea', { 'data-composer': true, defaultValue: 'Keep my draft' })
        )
      )
    })
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
    picker.setAttribute('open', '')
    await act(async () => {
      picker.querySelectorAll<HTMLButtonElement>('button')[1]!.click()
    })
    const selectedTarget = useContentReaderStore.getState().target
    assert.equal(selectedTarget?.kind === 'diff' ? selectedTarget.relativePath : null, 'reader.ts')
    assert.equal(picker.hasAttribute('open'), false)
    assert.equal(unmounts, 0)
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
