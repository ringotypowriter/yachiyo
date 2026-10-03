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
  counters = { queries: 0, scanned: 0, layouts: 0, textReads: 0 },
  options: { generation: string; query?: string; scopeRef?: string } = { generation: 'test' },
  setup?: (document: Document) => void,
  existingWindow?: ReturnType<typeof parseHTML>['window']
): {
  pageText: { viewport?: string; headings: string[]; snippets: string[] }
  refs: Array<{
    id?: string
    ref: string
    label?: string
    value?: string
    checked?: boolean
    disabled?: boolean
    expanded?: boolean
    role?: string
  }>
} {
  const window = existingWindow ?? parseHTML(html).window
  const document = window.document
  setup?.(document)
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
    if (!Object.hasOwn(element, 'innerText')) {
      Object.defineProperty(element, 'innerText', {
        get() {
          counters.textReads++
          return text
        }
      })
    }
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
    'globalThis',
    `return ${buildBrowserAutomationSnapshotScript(limit, options)}`
  )(
    window,
    document,
    window.Element,
    window.HTMLAnchorElement,
    undefined,
    {
      href: 'https://example.com/page'
    },
    window
  )
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

test('snapshot stores element identity rather than XPath and reports output truncation', () => {
  const snapshot = evaluateSnapshot(
    `<html><body>${'<button data-box data-y="10"></button>'.repeat(800)}<button id="last" data-box data-y="20"></button></body></html>`,
    3
  )
  assert.equal(snapshot.refs.length, 3)
  assert.deepEqual(
    snapshot.refs.map((ref) => ref.ref),
    ['test:1', 'test:2', 'test:3']
  )
  assert.match(snapshot.pageText.viewport ?? '', /truncated/)
})

test('snapshot exposes accessible control state and never exposes password values', () => {
  const snapshot = evaluateSnapshot(
    `<html><body>
    <label for="user">User name</label><input id="user" data-box data-y="10" value="Alice">
    <label for="secret">Password</label><input id="secret" type="password" data-box data-y="40" value="private">
    <input id="agree" type="checkbox" aria-label="Agree" checked disabled data-box data-y="70">
    <button id="more" aria-expanded="true" data-box data-y="100">Details</button>
  </body></html>`,
    10
  )
  assert.equal(snapshot.refs[0]?.label, 'User name')
  assert.equal(snapshot.refs[0]?.value, 'Alice')
  assert.equal(snapshot.refs[0]?.role, 'textbox')
  assert.equal(snapshot.refs[1]?.label, 'Password')
  assert.equal(snapshot.refs[1]?.value, undefined)
  assert.equal(snapshot.refs[2]?.checked, true)
  assert.equal(snapshot.refs[2]?.disabled, true)
  assert.equal(snapshot.refs[3]?.expanded, true)
})

test('query matches displayed associated labels and live control values, not stale attributes', () => {
  const html = `<html><body>
    <label for="user">Account owner</label><input id="user" data-box data-y="10" value="old account">
    <label>Wrapped address <textarea id="memo" data-box data-y="40">old memo</textarea></label>
    <span id="named">Invoice recipient</span><select id="choice" aria-labelledby="named" data-box data-y="70"><option value="old">Old</option><option value="new">New</option></select>
    <input id="secret" type="password" aria-label="Secret code" value="hidden secret" data-box data-y="100">
  </body></html>`
  const setup = (document: Document): void => {
    ;(document.querySelector('#user') as HTMLInputElement).value = 'fresh account'
    ;(document.querySelector('#memo') as HTMLTextAreaElement).value = 'fresh memo'
    Object.defineProperty(document.querySelector('#choice'), 'value', { value: 'new' })
    ;(document.querySelector('#secret') as HTMLInputElement).value = 'updated secret'
  }
  const search = (query: string): ReturnType<typeof evaluateSnapshot>['refs'] =>
    evaluateSnapshot(html, 10, undefined, { generation: 'q', query }, setup).refs
  assert.deepEqual(
    search('Account owner').map((ref) => ref.id),
    ['user']
  )
  assert.deepEqual(
    search('Wrapped address').map((ref) => ref.id),
    ['memo']
  )
  assert.deepEqual(
    search('Invoice recipient').map((ref) => ref.id),
    ['choice']
  )
  assert.deepEqual(
    search('fresh account').map((ref) => ref.id),
    ['user']
  )
  assert.deepEqual(
    search('fresh memo').map((ref) => ref.id),
    ['memo']
  )
  assert.deepEqual(
    search('new').map((ref) => ref.id),
    ['choice']
  )
  assert.deepEqual(
    search('old account').map((ref) => ref.id),
    []
  )
  assert.deepEqual(
    search('hidden secret').map((ref) => ref.id),
    []
  )
  assert.deepEqual(
    search('updated secret').map((ref) => ref.id),
    []
  )
})

test('query finds associated labels inside open shadow roots and same-origin frames', () => {
  const snapshot = evaluateSnapshot(
    '<html><body><div id="host"></div><iframe id="same"></iframe></body></html>',
    10,
    undefined,
    { generation: 'q', query: 'Lookup' },
    (document) => {
      const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' })
      shadow.innerHTML = '<label for="shadowInput">Lookup shadow</label><input id="shadowInput">'
      shadow.querySelector('input')!.getBoundingClientRect = () => box({ y: 10 }) as DOMRect
      const frame = document.querySelector('iframe')!
      const inner = parseHTML(
        '<html><body><label for="frameInput">Lookup frame</label><input id="frameInput"></body></html>'
      ).document
      Object.defineProperty(frame, 'contentDocument', { value: inner })
      frame.getBoundingClientRect = () => box({ y: 30 }) as DOMRect
      inner.querySelector('input')!.getBoundingClientRect = () => box({ y: 10 }) as DOMRect
    }
  )
  assert.deepEqual(
    snapshot.refs.map((ref) => ref.id),
    ['shadowInput', 'frameInput']
  )
  assert.deepEqual(
    snapshot.refs.map((ref) => ref.label),
    ['Lookup shadow', 'Lookup frame']
  )
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

test('snapshot query and scope return local matches only', () => {
  const html = `<html><body><section id="group" data-box data-y="5">
    <button id="alpha" data-box data-y="10">Alpha</button>
    <button id="beta" data-box data-y="40">Beta</button>
  </section><button id="outside" data-box data-y="70">Alpha outside</button></body></html>`
  const snapshot = evaluateSnapshot(html, 10, undefined, { generation: 'q', query: 'Alpha' })
  assert.deepEqual(
    snapshot.refs.map((ref) => ref.id),
    ['alpha', 'outside']
  )
  const scoped = evaluateSnapshot(
    html,
    10,
    undefined,
    { generation: 'q', scopeRef: 'prior' },
    (document) => {
      ;(
        document.defaultView as typeof window & { __yachiyoBrowserRefs: Map<string, Element> }
      ).__yachiyoBrowserRefs = new Map([['prior', document.querySelector('#group')!]])
    }
  )
  assert.deepEqual(
    scoped.refs.map((ref) => ref.id),
    ['alpha', 'beta']
  )
})

test('query searches full control text and values even when displayed summaries are clipped', () => {
  const long = 'x'.repeat(130) + ' needle'
  const snapshot = evaluateSnapshot(
    `<html><body>
    <button id="button" data-box data-y="10">${long}</button>
    <label for="field">${long}</label><input id="field" data-box data-y="40">
    <input id="value" data-box data-y="70" value="${long}">
  </body></html>`,
    10,
    undefined,
    { generation: 'long', query: 'needle' }
  )
  assert.deepEqual(
    snapshot.refs.map((ref) => ref.id),
    ['button', 'field', 'value']
  )
  assert.ok(
    snapshot.refs.every((ref) => (ref.label?.length ?? 0) <= 120 && (ref.value?.length ?? 0) <= 120)
  )
})

test('snapshot traverses open shadow roots with the shared scan budget', () => {
  const snapshot = evaluateSnapshot(
    '<html><body><div id="host"></div></body></html>',
    10,
    undefined,
    { generation: 'shadow' },
    (document) => {
      const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' })
      shadow.innerHTML = '<button id="inside">Inside shadow</button>'
      shadow.querySelector('button')!.getBoundingClientRect = () => box({ y: 30 }) as DOMRect
    }
  )
  assert.deepEqual(
    snapshot.refs.map((ref) => ref.id),
    ['inside']
  )
})

test('snapshot reports inaccessible frames instead of pretending to inspect them', () => {
  const snapshot = evaluateSnapshot(
    '<html><body><iframe id="foreign"></iframe></body></html>',
    10,
    undefined,
    { generation: 'frame' },
    (document) => {
      Object.defineProperty(document.querySelector('iframe'), 'contentDocument', { value: null })
    }
  )
  assert.deepEqual(snapshot.refs, [])
  assert.match(snapshot.pageText.viewport ?? '', /Cross-origin frames inaccessible: 1/)
})

test('snapshot traverses same-origin iframe and offsets its ref box', () => {
  const snapshot = evaluateSnapshot(
    '<html><body><iframe id="same"></iframe></body></html>',
    10,
    undefined,
    { generation: 'frame' },
    (document) => {
      const frame = document.querySelector('iframe')!
      const inner = parseHTML(
        '<html><body><button id="inside">Frame button</button></body></html>'
      ).document
      Object.defineProperty(frame, 'contentDocument', { value: inner })
      frame.getBoundingClientRect = () => box({ x: 40, y: 50 }) as DOMRect
      inner.querySelector('button')!.getBoundingClientRect = () => box({ x: 10, y: 15 }) as DOMRect
    }
  )
  assert.equal(snapshot.refs[0]?.id, 'inside')
})

test('scoped query races replace the ref generation and reject stale or detached scope', () => {
  const html = `<html><body><section id="scope" role="button" data-box data-y="5">
    <button id="first" data-box data-y="10">First item</button>
    <button id="second" data-box data-y="40">Second item</button>
  </section></body></html>`
  const window = parseHTML(html).window
  const first = evaluateSnapshot(html, 10, undefined, { generation: 'one' }, undefined, window)
  const firstRef = first.refs.find((ref) => ref.id === 'first')!.ref
  const scope = window.document.querySelector('#scope')!
  const scopeRef = first.refs.find((ref) => ref.id === 'scope')!.ref
  const second = evaluateSnapshot(
    html,
    10,
    undefined,
    { generation: 'two', scopeRef, query: 'Second' },
    undefined,
    window
  )
  assert.deepEqual(
    second.refs.map((ref) => ref.id),
    ['scope', 'second']
  )
  assert.equal(second.refs[1]?.ref, 'two:2')
  assert.equal(
    (
      window as typeof window & { __yachiyoBrowserRefs: Map<string, Element> }
    ).__yachiyoBrowserRefs.has(firstRef),
    false
  )
  assert.throws(
    () =>
      evaluateSnapshot(html, 10, undefined, { generation: 'three', scopeRef }, undefined, window),
    /Stale browser scope ref/
  )
  scope.remove()
  assert.throws(
    () =>
      evaluateSnapshot(
        html,
        10,
        undefined,
        { generation: 'four', scopeRef: second.refs[1]!.ref },
        undefined,
        window
      ),
    /Stale browser scope ref/
  )
})
