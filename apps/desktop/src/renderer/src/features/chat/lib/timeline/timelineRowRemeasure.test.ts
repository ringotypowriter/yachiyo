import assert from 'node:assert/strict'
import test from 'node:test'

import {
  remeasureTimelineRowFromDescendant,
  resolveTimelineScrollOffsetAfterSizeChange,
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

test('resizing a row that intersects the viewport keeps scrollTop unchanged', () => {
  assert.equal(
    resolveTimelineScrollOffsetAfterSizeChange({
      itemEnd: 500,
      previousSize: 400,
      nextSize: 30,
      scrollOffset: 180
    }),
    180
  )
})

test('resizing a row fully above the viewport compensates by its size delta', () => {
  assert.equal(
    resolveTimelineScrollOffsetAfterSizeChange({
      itemEnd: 120,
      previousSize: 100,
      nextSize: 50,
      scrollOffset: 180
    }),
    130
  )
})
