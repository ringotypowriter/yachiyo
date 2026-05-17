import assert from 'node:assert/strict'
import test from 'node:test'

import { selectActivityScreenshotCapture } from './activityScreenshotSelection.ts'

test('selectActivityScreenshotCapture returns undefined without vetted window bounds', () => {
  assert.equal(
    selectActivityScreenshotCapture({
      displays: [{ displayId: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }]
    }),
    undefined
  )
})

test('selectActivityScreenshotCapture crops to the foreground window region', () => {
  assert.deepEqual(
    selectActivityScreenshotCapture({
      windowBounds: { x: 100.2, y: 50.5, width: 500.1, height: 300.1 },
      displays: [{ displayId: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }]
    }),
    {
      displayId: 1,
      selection: 'window-overlap',
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      captureBounds: { x: 100, y: 50, width: 501, height: 301 }
    }
  )
})

test('selectActivityScreenshotCapture chooses the display with the largest window overlap', () => {
  assert.deepEqual(
    selectActivityScreenshotCapture({
      windowBounds: { x: 1300, y: 100, width: 500, height: 400 },
      displays: [
        { displayId: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
        { displayId: 2, bounds: { x: 1440, y: 0, width: 1440, height: 900 } }
      ]
    })?.displayId,
    2
  )
})
