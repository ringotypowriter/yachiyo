import assert from 'node:assert/strict'
import test from 'node:test'
import { Virtualizer } from '@tanstack/virtual-core'

import {
  remeasureTimelineRowFromDescendant,
  shouldAdjustTimelineScrollForSizeChange
} from './timelineRowRemeasure.ts'

test('remeasureTimelineRowFromDescendant measures the enclosing virtual row', () => {
  const row = { dataset: { index: '3' } } as unknown as HTMLElement
  const descendant = {
    closest: (selector: string) => (selector === '.message-timeline-row' ? row : null)
  } as unknown as HTMLElement
  const measured: HTMLElement[] = []

  assert.equal(
    remeasureTimelineRowFromDescendant(descendant, (element) => measured.push(element)),
    true
  )
  assert.deepEqual(measured, [row])
})

test('remeasureTimelineRowFromDescendant ignores content outside a virtual row', () => {
  const descendant = { closest: () => null } as unknown as HTMLElement
  let measured = false

  assert.equal(
    remeasureTimelineRowFromDescendant(descendant, () => {
      measured = true
    }),
    false
  )
  assert.equal(measured, false)
})

test('only size changes fully above the viewport preserve the current visual anchor', () => {
  assert.equal(shouldAdjustTimelineScrollForSizeChange(120, 180), true)
  assert.equal(shouldAdjustTimelineScrollForSizeChange(180, 180), true)
  assert.equal(shouldAdjustTimelineScrollForSizeChange(240, 180), false)
})

for (const size of [50, 600]) {
  test(`tool row resize to ${size}px does not move a viewport intersecting that row`, () => {
    let scrollTop = 300
    const virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
      count: 10,
      getScrollElement: () => null,
      estimateSize: () => 200,
      initialRect: { width: 600, height: 400 },
      initialOffset: scrollTop,
      scrollToFn: (offset, { adjustments = 0 }) => {
        scrollTop = offset + adjustments
      },
      observeElementRect: () => {},
      observeElementOffset: () => {}
    })
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) =>
      shouldAdjustTimelineScrollForSizeChange(item.end, scrollTop)
    virtualizer.getVirtualItems()
    virtualizer.resizeItem(1, size)
    assert.equal(scrollTop, 300)
    virtualizer.resizeItem(0, 100)
    assert.equal(scrollTop, 200, 'a row fully above the viewport is compensated exactly once')
  })
}
