import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveThingsBoardWheelDelta } from './thingsBoardWheel.ts'

test('things board vertical wheel can drive horizontal scrolling', () => {
  assert.equal(
    resolveThingsBoardWheelDelta({
      deltaX: 0,
      deltaY: 48,
      horizontal: { scrollOffset: 40, viewportSize: 300, contentSize: 900 }
    }),
    48
  )
})

test('things board wheel leaves horizontal gestures native', () => {
  assert.equal(
    resolveThingsBoardWheelDelta({
      deltaX: 36,
      deltaY: 12,
      horizontal: { scrollOffset: 40, viewportSize: 300, contentSize: 900 }
    }),
    null
  )
})

test('things board wheel does not trap vertical wheel at horizontal edges', () => {
  assert.equal(
    resolveThingsBoardWheelDelta({
      deltaX: 0,
      deltaY: -24,
      horizontal: { scrollOffset: 0, viewportSize: 300, contentSize: 900 }
    }),
    null
  )
  assert.equal(
    resolveThingsBoardWheelDelta({
      deltaX: 0,
      deltaY: 24,
      horizontal: { scrollOffset: 600, viewportSize: 300, contentSize: 900 }
    }),
    null
  )
})
