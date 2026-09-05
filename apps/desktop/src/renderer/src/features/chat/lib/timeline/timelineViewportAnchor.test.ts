import assert from 'node:assert/strict'
import test from 'node:test'
import {
  captureTimelineViewportAnchor,
  restoreTimelineViewportAnchor
} from './timelineViewportAnchor.ts'

function viewport(zoom = 1): { container: HTMLElement; prepend: (height: number) => void } {
  let insertedHeight = 0
  const container = {
    scrollTop: 300,
    clientHeight: 400,
    currentCSSZoom: zoom,
    getBoundingClientRect: () => ({ top: 50 }),
    querySelectorAll: () => rows
  } as unknown as HTMLElement
  const rows = [
    { key: 'overscan', start: 0, height: 200 },
    { key: 'visible', start: 280, height: 100 },
    { key: 'next', start: 380, height: 200 }
  ].map(({ key, start, height }) => ({
    dataset: { timelineRowKey: key },
    getBoundingClientRect: () =>
      ({
        top: 50 + (start + insertedHeight - container.scrollTop) * zoom,
        bottom: 50 + (start + insertedHeight - container.scrollTop + height) * zoom
      }) as DOMRect
  }))
  return {
    container,
    prepend: (height) => {
      insertedHeight = height
    }
  }
}

test('prepend restores the actual visible row, including subsequent measured height corrections', () => {
  const { container, prepend } = viewport()
  const anchor = captureTimelineViewportAnchor(container)
  assert.deepEqual(anchor, { key: 'visible', top: -20 })
  assert.ok(anchor)
  prepend(1_000)
  assert.equal(restoreTimelineViewportAnchor(container, anchor), 1_000)
  assert.equal(container.scrollTop, 1_300)
  prepend(1_360)
  assert.equal(restoreTimelineViewportAnchor(container, anchor), 360)
  assert.equal(container.scrollTop, 1_660)
  assert.deepEqual(captureTimelineViewportAnchor(container), anchor)
  assert.equal(restoreTimelineViewportAnchor(container, anchor), 0)
})

test('missing anchors do not move the viewport', () => {
  const { container } = viewport()
  assert.equal(restoreTimelineViewportAnchor(container, { key: 'gone', top: 10 }), null)
  assert.equal(container.scrollTop, 300)
})

test('font-size CSS zoom does not mix screen pixels with layout scroll offsets', () => {
  const { container, prepend } = viewport(16 / 14)
  const anchor = captureTimelineViewportAnchor(container)!
  assert.ok(Math.abs(anchor.top + 20) < 0.001)
  prepend(1000)
  restoreTimelineViewportAnchor(container, anchor)
  assert.ok(Math.abs(container.scrollTop - 1300) < 0.001)
})
