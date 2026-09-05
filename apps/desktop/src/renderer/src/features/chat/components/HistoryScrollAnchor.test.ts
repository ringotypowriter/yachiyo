import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Virtualizer } from '@tanstack/virtual-core'
import { parseHTML } from 'linkedom'
import { HistoryScrollAnchor } from './HistoryScrollAnchor.tsx'

// Real virtualizer measurements and React before-mutation snapshots; only DOM
// geometry is simulated because linkedom has no layout engine.
test('prepend snapshots the latest reading position and follows keys across repeated pages and measurements', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  let notifyResize = (): void => {}
  const frames: FrameRequestCallback[] = []
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    },
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      constructor(callback: () => void) {
        notifyResize = callback
      }
      observe(): void {
        /* Resize delivery is controlled by the test. */
      }
      disconnect(): void {
        /* No native observer to dispose. */
      }
    }
  })
  const containerRef = createRef<HTMLDivElement>()
  const anchorRef = createRef<HistoryScrollAnchor>()
  const root = createRoot(document.getElementById('root')!)
  let keys = ['user-a', 'answer-a', 'user-b', 'answer-b']
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: keys.length,
    getScrollElement: () => containerRef.current,
    getItemKey: (index) => keys[index]!,
    estimateSize: () => 200,
    initialRect: { width: 600, height: 400 },
    overscan: 0,
    scrollToFn: (offset, { adjustments = 0 }) => {
      if (containerRef.current) containerRef.current.scrollTop = offset + adjustments
    },
    observeElementRect: () => {},
    observeElementOffset: () => {}
  })
  virtualizer.scrollToIndex = virtualizer.scrollToOffset = () => {
    throw new Error('History correction must not create a virtualizer navigation target')
  }
  const geometry = (element: HTMLDivElement | null): void => {
    if (!element) return
    element.getBoundingClientRect = () => {
      const start = Number(element.dataset.start)
      const top = start - (containerRef.current?.scrollTop ?? 0)
      return { top, bottom: top + Number(element.dataset.size) } as DOMRect
    }
  }
  const render = async (navigationKey: string | null = null): Promise<void> => {
    virtualizer.setOptions({
      ...virtualizer.options,
      count: keys.length,
      getItemKey: (index) => keys[index]!
    })
    // Feed the observed native offset, as the browser's scroll event does.
    virtualizer.scrollOffset = containerRef.current?.scrollTop ?? 0
    const measurements = virtualizer.getVirtualItems()
    await act(async () => {
      root.render(
        React.createElement(
          HistoryScrollAnchor,
          {
            ref: anchorRef,
            containerRef,
            threadId: 'thread',
            messages: keys.map((id) => ({ id })),
            navigationKey,
            resolveOffset: (key) =>
              virtualizer.measurementsCache.find((row) => row.key === key)?.start ?? null,
            onRestore: () => {}
          },
          React.createElement(
            'div',
            { ref: containerRef },
            React.createElement(
              'div',
              { style: { height: virtualizer.getTotalSize() } },
              measurements.map((row) =>
                React.createElement('div', {
                  key: row.key,
                  ref: geometry,
                  'data-timeline-row-key': String(row.key),
                  'data-start': row.start,
                  'data-size': row.size
                })
              )
            )
          )
        )
      )
    })
  }
  try {
    await render()
    const container = containerRef.current!
    Object.defineProperty(container, 'clientHeight', { value: 400 })
    container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
    container.scrollTop = 260
    await render()
    // Page request starts here. User keeps wheeling while it is in flight.
    anchorRef.current!.cancel()
    container.scrollTop = 310
    keys = ['older-1', 'older-2', ...keys]
    await render()
    assert.equal(container.scrollTop, 710, 'preserve the position at insertion, not request time')
    await render()
    // A second page shifts numeric indices again; the visible answer is unchanged.
    keys = ['oldest', ...keys]
    await render()
    assert.equal(container.scrollTop, 910)
    await render()
    virtualizer.scrollDirection = 'backward'
    let scrollTop: number = container.scrollTop
    const writes: number[] = []
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        writes.push(value)
        scrollTop = value
      }
    })
    virtualizer.resizeItem(0, 550)
    // The measurement cache can advance before React commits the new row transforms.
    virtualizer.getTotalSize()
    notifyResize()
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0)
    })
    assert.deepEqual(
      writes,
      [],
      'do not scroll to the cache estimate and immediately undo it against the DOM'
    )
    await render()
    assert.equal(container.scrollTop, 1260, 'follow the same key after measured height changes')
    assert.deepEqual(writes, [1260], 'apply one correction after the actual row moves')
    writes.length = 0
    notifyResize()
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0)
    })
    assert.equal(container.scrollTop, 1260)
    assert.deepEqual(writes, [], 'a settled anchor does not keep writing scrollTop')
    // Native keyboard/scrollbar scrolling must cancel before a virtualizer flushSync render.
    container.scrollTop = 1100
    container.dispatchEvent(new window.Event('scroll'))
    await render()
    assert.equal(container.scrollTop, 1100)
    // Explicit new-message navigation supersedes the reading anchor.
    await render('new-request')
    container.scrollTop = 1400
    virtualizer.resizeItem(0, 600)
    await render('new-request')
    assert.equal(container.scrollTop, 1400)
  } finally {
    await act(async () => root.unmount())
  }
})
