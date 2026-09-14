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
  limit: number,
  counters = { queries: 0, scanned: 0, layouts: 0, textReads: 0 }
): {
  pageText: { viewport?: string; headings: string[]; snippets: string[] }
  refs: Array<{ id?: string; xpath: string }>
} {
  const { window } = parseHTML(html)
  const document = window.document
  const elements = Array.from(document.querySelectorAll('[data-box]'))

  for (const element of elements) {
    const rect = box({
      y: Number(element.getAttribute('data-y')),
      width: Number(element.getAttribute('data-width')) || undefined
    })
    element.getBoundingClientRect = () => {
      counters.layouts++
      return rect as DOMRect
    }
  }

  const querySelectorAll = document.querySelectorAll.bind(document)
  document.querySelectorAll = ((selector: string) => {
    counters.queries++
    return querySelectorAll(selector)
  }) as typeof document.querySelectorAll
  const createTreeWalker = document.createTreeWalker.bind(document)
  document.createTreeWalker = ((...args: Parameters<typeof document.createTreeWalker>) => {
    const walker = createTreeWalker(...args)
    const nextNode = walker.nextNode.bind(walker)
    walker.nextNode = () => {
      counters.scanned++
      return nextNode()
    }
    return walker
  }) as typeof document.createTreeWalker
  for (const element of elements) {
    const text = element.textContent
    Object.defineProperty(element, 'innerText', {
      get() {
        counters.textReads++
        return text
      }
    })
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

test('snapshot bounds scanning of a large DOM including nonmatching nodes', () => {
  const counters = { queries: 0, scanned: 0, layouts: 0, textReads: 0 }
  const html = `<html><body>${'<div> </div>'.repeat(15000)}<button id="late" data-box data-y="1">Late</button></body></html>`
  const snapshot = evaluateSnapshot(html, 3, counters)
  assert.equal(counters.queries, 0, 'must not materialize whole-document selector results')
  assert.ok(counters.scanned <= 10000, JSON.stringify(counters))
  assert.deepEqual(snapshot.refs, [])
  assert.match(snapshot.pageText.viewport ?? '', /scan budget reached/)
})

test('snapshot bounds interactive candidates and reads each layout only once', () => {
  const counters = { queries: 0, scanned: 0, layouts: 0, textReads: 0 }
  const buttons = Array.from(
    { length: 3000 },
    (_, i) => `<button id="b${i}" data-box data-y="${i === 999 ? 10 : 900 + i}"></button>`
  ).join('')
  const snapshot = evaluateSnapshot(`<html><body>${buttons}</body></html>`, 3, counters)
  assert.deepEqual(
    snapshot.refs.map((ref) => ref.id),
    ['b999', 'b0', 'b1']
  )
  assert.ok(counters.layouts <= 1000, JSON.stringify(counters))
  assert.match(snapshot.pageText.viewport ?? '', /scan budget reached/)
})

test('snapshot stops semantic text reads at output quotas and deduplicates viewport text', () => {
  const counters = { queries: 0, scanned: 0, layouts: 0, textReads: 0 }
  const heading = '<h2 data-box data-y="10">Repeated heading</h2>'
  const paragraph = `<p data-box data-y="40">${'Visible prose '.repeat(20)}</p>`
  const snapshot = evaluateSnapshot(
    `<html><body>${heading.repeat(100)}${paragraph.repeat(100)}</body></html>`,
    0,
    counters
  )
  assert.equal(snapshot.pageText.headings.length, 12)
  assert.equal(snapshot.pageText.snippets.length, 20)
  assert.equal(counters.textReads, 32)
  assert.equal(snapshot.pageText.viewport?.split('Repeated heading').length, 2)
})

test('snapshot stops viewport layout reads once enough unique text is collected', () => {
  const counters = { queries: 0, scanned: 0, layouts: 0, textReads: 0 }
  const spans = Array.from(
    { length: 5000 },
    (_, i) => `<span data-box data-y="10">${i} ${'x'.repeat(235)}</span>`
  ).join('')
  const snapshot = evaluateSnapshot(`<html><body>${spans}</body></html>`, 0, counters)
  assert.equal(snapshot.pageText.viewport?.length, 2000)
  assert.ok(counters.layouts <= 9, JSON.stringify(counters))
})

test('snapshot omits unusable refs on XPath budget exhaustion but retains ID paths', () => {
  const snapshot = evaluateSnapshot(
    `<html><body>${'<button data-box data-y="10"></button>'.repeat(800)}<button id="last" data-box data-y="20"></button></body></html>`,
    1000
  )
  assert.ok(snapshot.refs.length > 1 && snapshot.refs.length < 200)
  assert.ok(snapshot.refs.every((ref) => ref.xpath.startsWith('/')))
  assert.equal(snapshot.refs.at(-1)?.xpath, '//*[@id="last"]')
  assert.match(snapshot.pageText.viewport ?? '', /scan budget reached/)
})

test('snapshot continues collecting body text after the interactive candidate budget', () => {
  const snapshot = evaluateSnapshot(
    `<html><body>${'<button data-box data-y="900"></button>'.repeat(1001)}<span data-box data-y="10">Later visible body text</span></body></html>`,
    1
  )
  assert.match(snapshot.pageText.viewport ?? '', /Later visible body text/)
})

test('snapshot preserves body visibility exclusions and first-seen text ordering', () => {
  const snapshot = evaluateSnapshot(
    `<html><head><title data-box data-y="10">Not body text</title></head><body>
      <div hidden><span data-box data-y="10">Hidden text</span></div>
      <div aria-hidden="true"><span data-box data-y="10">Aria hidden text</span></div>
      <script data-box data-y="10">Script text</script>
      <span data-box data-y="900">Offscreen text</span>
      <span data-box data-y="10">First text</span>
      <span data-box data-y="20">First text</span>
      <span data-box data-y="30">Second text</span>
    </body></html>`,
    0
  )
  assert.equal(snapshot.pageText.viewport, 'First text Second text')
})
