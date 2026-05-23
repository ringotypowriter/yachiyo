import assert from 'node:assert/strict'
import test from 'node:test'

import { parseHTML } from 'linkedom'

import { buildBrowserAutomationSnapshotScript } from './browserAutomationSnapshotScript.ts'

interface Box {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

function box(input: { x?: number; y: number; width?: number; height?: number }): Box {
  const x = input.x ?? 0
  const width = input.width ?? 120
  const height = input.height ?? 24
  return {
    x,
    y: input.y,
    width,
    height,
    top: input.y,
    right: x + width,
    bottom: input.y + height,
    left: x
  }
}

function evaluateSnapshot(
  html: string,
  limit: number
): { pageText: { viewport?: string }; refs: Array<{ id?: string }> } {
  const { window } = parseHTML(html)
  const document = window.document
  const elements = Array.from(document.querySelectorAll('[data-box]'))

  for (const element of elements) {
    const rect = box({
      y: Number(element.getAttribute('data-y')),
      width: Number(element.getAttribute('data-width')) || undefined
    })
    element.getBoundingClientRect = () => rect as DOMRect
  }

  window.getComputedStyle = () =>
    ({ display: 'block', visibility: 'visible' }) as CSSStyleDeclaration
  Object.defineProperty(window, 'innerHeight', { value: 600 })
  Object.defineProperty(window, 'innerWidth', { value: 800 })

  return Function(
    'window',
    'document',
    'Element',
    'HTMLAnchorElement',
    'CSS',
    'location',
    `return ${buildBrowserAutomationSnapshotScript(limit)}`
  )(window, document, window.Element, window.HTMLAnchorElement, undefined, {
    href: 'https://example.com/page'
  })
}

test('browser automation snapshot prioritizes refs visible in the viewport', () => {
  const offscreenLinks = Array.from({ length: 8 }, (_, index) => {
    const id = `offscreen-${index + 1}`
    return `<a id="${id}" href="#${id}" data-box data-y="${900 + index * 30}">${id}</a>`
  }).join('')

  const snapshot = evaluateSnapshot(
    `<!doctype html>
      <html>
        <head><title>Example</title></head>
        <body>
          ${offscreenLinks}
          <button id="target" data-box data-y="120">Useful action</button>
        </body>
      </html>`,
    3
  )

  assert.deepEqual(
    snapshot.refs.map((ref) => ref.id),
    ['target', 'offscreen-1', 'offscreen-2']
  )
})

test('browser automation snapshot includes visible text nodes outside semantic tags', () => {
  const snapshot = evaluateSnapshot(
    `<!doctype html>
      <html>
        <head><title>Example</title></head>
        <body>
          <main>
            <div data-box data-y="120">
              <span data-box data-y="120">&gt; yachiyo@1.1.9-beta build /Users/runner/work/yachiyo/yachiyo</span>
            </div>
          </main>
        </body>
      </html>`,
    10
  )

  assert.match(snapshot.pageText.viewport ?? '', /yachiyo@1\.1\.9-beta build/)
  assert.equal(snapshot.refs.length, 0)
})
