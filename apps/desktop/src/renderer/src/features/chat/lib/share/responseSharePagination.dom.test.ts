import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import {
  allocateSharePages,
  measureShareUnits,
  renderSharePageContent,
  type DOMShareUnit
} from './responseSharePagination.ts'

function fixture(markup: string): HTMLElement {
  const { document } = parseHTML(`<html><body><main id="source">${markup}</main></body></html>`)
  return document.querySelector('main')!
}

function unit(source: HTMLElement): DOMShareUnit {
  return { source, height: 20 }
}

// linkedom has no browser text-layout or setStart/setEnd implementation. These
// child-boundary fixtures exercise range merging and DOM cloning, not geometry
// or browser Range's handling of offsets inside text nodes.
function childRange(source: HTMLElement, start: number, end: number): Range {
  let endOffset = end
  return {
    startContainer: source,
    startOffset: start,
    endContainer: source,
    get endOffset() {
      return endOffset
    },
    cloneRange: () => childRange(source, start, endOffset),
    setEnd(container: Node, offset: number) {
      assert.equal(container, source)
      endOffset = offset
    },
    cloneContents() {
      const fragment = source.ownerDocument.createDocumentFragment()
      for (const child of Array.from(source.childNodes).slice(start, endOffset)) {
        fragment.append(child.cloneNode(true))
      }
      return fragment
    }
  } as unknown as Range
}

test('page fragments merge shared ancestors once and leave source DOM untouched', () => {
  const content = fixture(
    '<section class="answer"><blockquote><p>First</p><p>Second</p></blockquote><p>Third</p></section>'
  )
  const before = content.outerHTML
  const units = Array.from(content.querySelectorAll('p')).map(unit)
  const page = renderSharePageContent(content, units)

  assert.equal(page.hasAttribute('id'), false)
  assert.equal(page.querySelectorAll('section.answer').length, 1)
  assert.equal(page.querySelectorAll('blockquote').length, 1)
  assert.deepEqual(
    Array.from(page.querySelectorAll('p')).map((node) => node.textContent),
    ['First', 'Second', 'Third']
  )
  assert.equal(content.outerHTML, before)
})

test('each table page repeats the header once even when it contains multiple row fragments', () => {
  const content = fixture(
    '<section><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr><tr><td>C</td><td>3</td></tr></tbody></table></section>'
  )
  const rows = Array.from(content.querySelectorAll<HTMLElement>('tbody tr'))
  const first = renderSharePageContent(content, rows.slice(0, 2).map(unit))
  const second = renderSharePageContent(content, rows.slice(2).map(unit))

  assert.equal(first.querySelectorAll('table').length, 1)
  assert.equal(first.querySelectorAll('thead').length, 1)
  assert.equal(first.querySelectorAll('tbody').length, 1)
  assert.equal(second.querySelectorAll('thead').length, 1)
  assert.deepEqual(
    Array.from(first.querySelectorAll('tbody tr')).map((node) => node.textContent),
    ['A1', 'B2']
  )
  assert.deepEqual(
    Array.from(second.querySelectorAll('tbody tr')).map((node) => node.textContent),
    ['C3']
  )
  assert.equal(
    first.querySelector('thead')!.textContent,
    second.querySelector('thead')!.textContent
  )
})

test('ordered list continuation preserves a non-default starting number', () => {
  const content = fixture('<ol start="4"><li>Four</li><li>Five</li><li>Six</li></ol>')
  const items = Array.from(content.querySelectorAll<HTMLElement>('li'))
  const first = renderSharePageContent(content, items.slice(0, 1).map(unit))
  const second = renderSharePageContent(content, items.slice(1).map(unit))

  assert.equal(first.querySelector('ol')!.getAttribute('start'), '4')
  assert.equal(second.querySelector('ol')!.getAttribute('start'), '5')
  assert.equal(second.querySelectorAll('ol').length, 1)
  assert.deepEqual(
    Array.from(second.querySelectorAll('li')).map((node) => node.textContent),
    ['Five', 'Six']
  )
})

test('adjacent inline fragments merge once without dropping whitespace or duplicating text', () => {
  const content = fixture(
    '<section><p>Alpha <em>emphasis</em> <a href="https://example.com">link</a> omega</p></section>'
  )
  const paragraph = content.querySelector('p')!
  const units: DOMShareUnit[] = [
    { ...unit(paragraph), range: childRange(paragraph, 0, 2) },
    { ...unit(paragraph), range: childRange(paragraph, 2, 4) },
    { ...unit(paragraph), range: childRange(paragraph, 4, 5) }
  ]
  const merged = renderSharePageContent(content, units)
  const first = renderSharePageContent(content, units.slice(0, 1))
  const second = renderSharePageContent(content, units.slice(1))

  assert.equal(merged.querySelectorAll('p').length, 1)
  assert.equal(merged.querySelector('p')!.innerHTML, paragraph.innerHTML)
  assert.equal(first.textContent! + second.textContent!, paragraph.textContent)
  assert.equal(merged.querySelectorAll('em').length, 1)
  assert.equal(merged.querySelectorAll('a').length, 1)
  assert.equal(second.querySelector('a')!.getAttribute('href'), 'https://example.com')
})

test('code continuation label appears only on continued pages and never duplicates within a page', () => {
  const content = fixture(
    '<section><pre><code>first\n</code><code>second\n</code><code>third</code></pre></section>'
  )
  const source = content.querySelector('pre')!
  const units: DOMShareUnit[] = [0, 1, 2].map((index) => ({
    ...unit(source),
    range: childRange(source, index, index + 1),
    continuation: 'Code (continued)'
  }))
  const first = renderSharePageContent(content, units.slice(0, 1))
  const second = renderSharePageContent(content, units.slice(1))

  assert.equal(first.textContent, 'first\n')
  assert.equal(second.querySelectorAll('pre').length, 1)
  assert.equal(second.querySelectorAll('div').length, 1)
  assert.equal(second.querySelector('div')!.textContent, 'Code (continued)')
  assert.equal(second.querySelector('pre')!.textContent, 'second\nthird')
})

test('tool fragments repeat one continuation heading only when the original heading is absent', () => {
  const content = fixture(
    '<section class="response-share-tool"><div class="response-share-tool-heading">Read file</div><div class="tool-body"><p>Input</p><p>Output one</p><p>Output two</p></div></section>'
  )
  const heading = content.querySelector<HTMLElement>('.response-share-tool-heading')!
  const paragraphs = Array.from(content.querySelectorAll<HTMLElement>('p'))
  const first = renderSharePageContent(content, [unit(heading), unit(paragraphs[0]!)])
  const second = renderSharePageContent(content, paragraphs.slice(1).map(unit))

  assert.equal(first.querySelectorAll('.response-share-tool-heading').length, 1)
  assert.equal(first.querySelector('.response-share-tool-heading')!.textContent, 'Read file')
  assert.equal(second.querySelectorAll('.response-share-tool').length, 1)
  assert.equal(second.querySelectorAll('.response-share-tool-heading').length, 1)
  assert.equal(
    second.querySelector('.response-share-tool-heading')!.textContent,
    'Read file (continued)'
  )
  assert.deepEqual(
    Array.from(second.querySelectorAll('p')).map((node) => node.textContent),
    ['Output one', 'Output two']
  )
})

test('ordered list continuation respects zero, explicit item values and reversed lists', () => {
  const content = fixture(
    '<ol start="0"><li>Zero</li><li value="5">Five</li><li>Six</li></ol><ol reversed><li>Three</li><li>Two</li><li>One</li></ol>'
  )
  const lists = content.querySelectorAll<HTMLElement>('ol')
  const zeroItems = lists[0]!.querySelectorAll<HTMLElement>('li')
  const reversedItems = lists[1]!.querySelectorAll<HTMLElement>('li')

  const zero = renderSharePageContent(content, [unit(zeroItems[0]!)])
  const six = renderSharePageContent(content, [unit(zeroItems[2]!)])
  const reversed = renderSharePageContent(content, [
    unit(reversedItems[1]!),
    unit(reversedItems[2]!)
  ])

  assert.equal(zero.querySelector('ol')!.getAttribute('start'), '0')
  assert.equal(six.querySelector('ol')!.getAttribute('start'), '6')
  assert.equal(reversed.querySelector('ol')!.getAttribute('start'), '2')
  assert.equal(reversed.querySelector('ol')!.hasAttribute('reversed'), true)
  assert.deepEqual(
    Array.from(reversed.querySelectorAll('li')).map((node) => node.textContent),
    ['Two', 'One']
  )
})

test('direct text around a nested list retains its order inside one parent list item', () => {
  const content = fixture('<ul><li>Before <ul><li>Nested</li></ul> After</li></ul>')
  const parentItem = content.querySelector('li')!
  const nestedItem = parentItem.querySelector('li')!
  const units: DOMShareUnit[] = [
    { ...unit(parentItem), direct: true, range: childRange(parentItem, 0, 1) },
    unit(nestedItem),
    { ...unit(parentItem), direct: true, range: childRange(parentItem, 2, 3) }
  ]
  const page = renderSharePageContent(content, units)

  assert.equal(page.innerHTML, content.innerHTML)
  assert.equal(page.textContent, 'Before Nested After')
  assert.equal(page.querySelectorAll('ul').length, 2)
  assert.equal(page.querySelectorAll('li').length, 2)
  assert.equal(page.firstElementChild!.children.length, 1)
})

test('direct paragraph text around inline media preserves text and media exactly once', () => {
  const content = fixture(
    '<section><p>Before <img src="data:image/png;base64,AA==" alt="diagram"> After</p></section>'
  )
  const paragraph = content.querySelector('p')!
  const image = paragraph.querySelector('img')!
  const units: DOMShareUnit[] = [
    { ...unit(paragraph), direct: true, range: childRange(paragraph, 0, 1) },
    unit(image),
    { ...unit(paragraph), direct: true, range: childRange(paragraph, 2, 3) }
  ]
  const page = renderSharePageContent(content, units)

  assert.equal(page.innerHTML, content.innerHTML)
  assert.equal(page.textContent, 'Before  After')
  assert.equal(page.querySelectorAll('p').length, 1)
  assert.equal(page.querySelectorAll('img').length, 1)
  assert.equal(page.querySelector('p')!.childNodes[1]!.nodeName, 'IMG')
})

test('mixed-content measurement visits direct text before and after nested content', (t) => {
  const content = fixture(
    '<ul><li>Before <ul><li>Nested</li></ul> After</li></ul><p>Image before <img alt="diagram"> Image after</p>'
  )
  const document = content.ownerDocument
  // Deterministic geometry forces wrapper descent. This checks traversal only,
  // not real font metrics, line wrapping, or resulting page dimensions.
  for (const key of ['NodeFilter', 'getComputedStyle'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
  Object.defineProperty(globalThis, 'NodeFilter', { configurable: true, value: { SHOW_TEXT: 4 } })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({}) })
  const bounds = (height: number): DOMRect => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: height,
    width: 100,
    height,
    toJSON: () => ({})
  })
  for (const element of content.querySelectorAll<HTMLElement>('*')) {
    t.mock.method(element, 'getBoundingClientRect', () =>
      bounds(element.tagName === 'IMG' || element.textContent === 'Nested' ? 20 : 400)
    )
  }
  t.mock.method(document, 'createRange', () => {
    let start: Node
    let end: Node
    let startOffset = 0
    let endOffset = 0
    return {
      get startContainer() {
        return start
      },
      get endContainer() {
        return end
      },
      get startOffset() {
        return startOffset
      },
      get endOffset() {
        return endOffset
      },
      setStart(node: Node, offset: number) {
        start = node
        startOffset = offset
      },
      setEnd(node: Node, offset: number) {
        end = node
        endOffset = offset
      },
      getBoundingClientRect: () => bounds(20),
      cloneContents() {
        assert.equal(start, end)
        const fragment = document.createDocumentFragment()
        fragment.append(document.createTextNode(start.textContent!.slice(startOffset, endOffset)))
        return fragment
      }
    } as unknown as Range
  })

  const units = measureShareUnits(content, 100)

  assert.deepEqual(
    units.map((entry) =>
      entry.direct
        ? Array.from(entry.range!.cloneContents().childNodes)
            .map((node) => node.textContent)
            .join('')
        : entry.source.tagName
    ),
    ['Before ', 'UL', ' After', 'Image before ', 'IMG', ' Image after']
  )
  assert.deepEqual(
    units.filter((entry) => entry.direct).map((entry) => entry.source.tagName),
    ['LI', 'LI', 'P', 'P']
  )
})

test('table measurement charges its repeated header once per page rather than once per row', (t) => {
  const rows = Array.from({ length: 260 }, (_, index) => `<tr><td>Row ${index + 1}</td></tr>`).join(
    ''
  )
  const content = fixture(
    `<table><thead><tr><th>Heading</th></tr></thead><tbody>${rows}</tbody></table>`
  )
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'getComputedStyle', descriptor)
    else Reflect.deleteProperty(globalThis, 'getComputedStyle')
  })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({}) })
  // Synthetic sizes isolate repeated-header accounting from browser layout.
  for (const element of content.querySelectorAll<HTMLElement>('*')) {
    const height =
      element.tagName === 'TABLE'
        ? 5280
        : element.tagName === 'TBODY'
          ? 5200
          : element.closest('thead')
            ? 80
            : 20
    t.mock.method(element, 'getBoundingClientRect', () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: height,
      width: 100,
      height,
      toJSON: () => ({})
    }))
  }

  const units = measureShareUnits(content, 850)
  const pages = allocateSharePages(units, { layout: 'pages', chromeHeight: 230 })

  assert.equal(units.length, 260)
  assert.ok(units.every((entry) => entry.height === 20 && entry.overhead === 80))
  assert.equal(pages.length, 7)
  assert.deepEqual(pages.flat(), units)
  const rendered = pages.map((page) => renderSharePageContent(content, page))
  assert.ok(rendered.every((page) => page.querySelectorAll('thead').length === 1))
  assert.deepEqual(
    rendered.flatMap((page) =>
      Array.from(page.querySelectorAll('tbody tr')).map((row) => row.textContent)
    ),
    Array.from({ length: 260 }, (_, index) => `Row ${index + 1}`)
  )
})
