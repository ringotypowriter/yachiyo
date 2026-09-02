import assert from 'node:assert/strict'
import test from 'node:test'

import { remeasureTimelineRowFromDescendant } from './timelineRowRemeasure.ts'

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
