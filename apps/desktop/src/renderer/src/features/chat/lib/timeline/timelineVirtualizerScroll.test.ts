import assert from 'node:assert/strict'
import test from 'node:test'
import { Virtualizer } from '@tanstack/virtual-core'
import { createTimelineVirtualizerScroll } from './timelineVirtualizerScroll.ts'
import { shouldAdjustTimelineScrollForSizeChange } from './timelineRowRemeasure.ts'

function createMeasuredViewport(
  initialOffset = 4189,
  rowSize = 620
): {
  element: EventTarget & { scrollTop: number; scrollHeight: number }
  virtualizer: Virtualizer<HTMLElement, HTMLElement>
  cleanup: () => void
} {
  const element = Object.assign(new EventTarget(), {
    scrollTop: initialOffset,
    scrollHeight: 20000,
    clientHeight: 600,
    ownerDocument: {
      defaultView: {
        setTimeout: () => 1,
        clearTimeout: () => {},
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {}
      }
    },
    scrollTo(options: ScrollToOptions): void {
      this.scrollTop = Math.max(
        0,
        Math.min(options.top ?? this.scrollTop, this.scrollHeight - this.clientHeight)
      )
    }
  })
  const virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
    count: 20,
    getScrollElement: () => element as unknown as HTMLElement,
    estimateSize: () => rowSize,
    initialOffset,
    initialRect: { width: 600, height: 600 },
    observeElementRect: () => {},
    ...createTimelineVirtualizerScroll()
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) =>
    shouldAdjustTimelineScrollForSizeChange(item.end, element.scrollTop)
  const cleanup = virtualizer._didMount()
  virtualizer._willUpdate()
  virtualizer.getVirtualItems()
  return { element, virtualizer, cleanup }
}

test('measurement corrections use the live viewport, not the previous native scroll event', () => {
  const { element, virtualizer, cleanup } = createMeasuredViewport()
  try {
    // Captured dev trace: browser is at3377, virtualizer still remembers4189.
    element.scrollTop = 3377
    virtualizer.resizeItem(4, 847)
    assert.equal(
      element.scrollTop,
      3604,
      'apply only the227px height delta, not stale scroll history'
    )
    virtualizer.resizeItem(3, 612)
    assert.equal(
      element.scrollTop,
      3596,
      'successive measurements must not reapply accumulated deltas'
    )
    // More upward movement can precede delivery of the next native scroll event.
    cleanup()
    virtualizer._willUpdate()
    element.scrollTop = 3596
    virtualizer.resizeItem(3, 613)
    assert.equal(
      element.scrollTop,
      3597,
      'observer reattachment alone does not reset the core batch'
    )
    element.scrollTop = 3200
    virtualizer.resizeItem(1, 720)
    assert.equal(element.scrollTop, 3300)
    element.dispatchEvent(new Event('scroll'))
    assert.equal(virtualizer.scrollOffset, 3300)
    virtualizer.resizeItem(0, 630)
    assert.equal(
      element.scrollTop,
      3310,
      'a delivered scroll event starts a fresh adjustment batch'
    )
    virtualizer.scrollToOffset(5000)
    assert.equal(element.scrollTop, 5000, 'explicit navigation still uses absolute offsets')
  } finally {
    cleanup()
  }
})

test('a clamped height correction remains pending until the spacer grows', () => {
  const { element, virtualizer, cleanup } = createMeasuredViewport(1000, 200)
  try {
    element.scrollHeight = 1600
    virtualizer.resizeItem(0, 300)
    assert.equal(element.scrollTop, 1000)
    element.scrollHeight = 1700
    virtualizer.resizeItem(1, 220)
    assert.equal(element.scrollTop, 1100, 'recover movement blocked by the old spacer height')
  } finally {
    cleanup()
  }
})
