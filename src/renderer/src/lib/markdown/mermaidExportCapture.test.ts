import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'

import { findMermaidPngExportSvg, serializeMermaidSvgForPng } from './mermaidExportCapture.ts'

function installDom(html: string): Document {
  const { document, Element, HTMLElement, HTMLButtonElement } = parseHTML(html).window
  globalThis.Element = Element
  globalThis.HTMLElement = HTMLElement
  globalThis.HTMLButtonElement = HTMLButtonElement
  globalThis.XMLSerializer = class {
    serializeToString(element: Element): string {
      return element.outerHTML
    }
  } as typeof XMLSerializer
  return document
}

test('findMermaidPngExportSvg returns the rendered SVG for Mermaid PNG menu clicks', () => {
  const document = installDom(`
    <div data-streamdown="mermaid-block">
      <div data-streamdown="mermaid-block-actions">
        <button id="png">PNG</button>
      </div>
      <div aria-label="Mermaid chart" id="chart">
        <svg id="diagram" viewBox="0 0 640 360"></svg>
      </div>
    </div>
  `)

  assert.equal(
    findMermaidPngExportSvg(document.querySelector('#png')),
    document.querySelector('#diagram')
  )
})

test('findMermaidPngExportSvg ignores non-PNG Mermaid menu clicks', () => {
  const document = installDom(`
    <div data-streamdown="mermaid-block">
      <div data-streamdown="mermaid-block-actions">
        <button id="svg">SVG</button>
      </div>
      <div aria-label="Mermaid chart" id="chart">
        <svg id="diagram" viewBox="0 0 640 360"></svg>
      </div>
    </div>
  `)

  assert.equal(findMermaidPngExportSvg(document.querySelector('#svg')), null)
})

test('findMermaidPngExportSvg does not fall back to loading placeholders', () => {
  const document = installDom(`
    <div data-streamdown="mermaid-block">
      <div data-streamdown="mermaid-block-actions">
        <button id="png">PNG</button>
      </div>
      <div>Loading diagram...</div>
    </div>
  `)

  assert.equal(findMermaidPngExportSvg(document.querySelector('#png')), null)
})

test('serializeMermaidSvgForPng preserves the full viewBox dimensions', () => {
  const document = installDom(`
    <svg id="diagram" viewBox="0 0 1200 800" style="width: 300px; height: 200px">
      <rect width="1200" height="800"></rect>
    </svg>
  `)

  const svg = document.querySelector('#diagram')
  assert(svg instanceof Element)

  const serialized = serializeMermaidSvgForPng(svg)
  assert.equal(serialized.width, 1200)
  assert.equal(serialized.height, 800)
  assert.match(serialized.svgText, /width="1200"/)
  assert.match(serialized.svgText, /height="800"/)
})
