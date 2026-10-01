import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { useFloatingPanelLayout } from './useFloatingPanelLayout'

test('a top popup stays next to its anchor when content shrinks and grows again', async () => {
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
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true
  }
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 })
  const root = createRoot(document.getElementById('root')!)
  let contentHeight = 420
  let updateLayout = (): void => {
    return
  }
  function Popup(): React.JSX.Element {
    const ref = useRef<HTMLDivElement>(null)
    const result = useFloatingPanelLayout({
      open: true,
      anchor: { top: 600, bottom: 650, left: 100, right: 400 },
      floatingRef: ref,
      width: 280,
      maxHeight: 420,
      preferredPlacement: 'top'
    })
    useLayoutEffect(() => {
      updateLayout = result.updateLayout
    }, [result.updateLayout])
    return (
      <div
        style={result.style}
        ref={(element) => {
          ref.current = element
          if (!element) return
          Object.defineProperties(element, {
            offsetHeight: {
              configurable: true,
              get: () =>
                Math.min(contentHeight, Number.parseFloat(element.style.maxHeight) || Infinity)
            },
            scrollHeight: {
              configurable: true,
              get: () =>
                Math.min(contentHeight, Number.parseFloat(element.style.maxHeight) || Infinity)
            }
          })
        }}
      />
    )
  }
  try {
    await act(async () => root.render(<Popup />))
    const panel = document.getElementById('root')!.firstElementChild as HTMLDivElement
    assert.equal(panel.style.top, '172px')
    contentHeight = 132
    await act(async () => updateLayout())
    assert.equal(Number.parseFloat(panel.style.top) + contentHeight, 592)
    contentHeight = 300
    await act(async () => updateLayout())
    assert.equal(Number.parseFloat(panel.style.top) + contentHeight, 592)
    assert.equal(panel.style.maxHeight, '300px')
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
