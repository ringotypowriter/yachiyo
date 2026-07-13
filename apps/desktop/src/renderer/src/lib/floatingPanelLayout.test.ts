import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveFloatingPanelLayout } from './floatingPanelLayout.ts'

test('shrinks and shifts a dropdown into a narrow viewport', () => {
  assert.deepEqual(
    resolveFloatingPanelLayout({
      anchor: { top: 300, right: 268, bottom: 328, left: 240 },
      panel: { width: 340, height: 420 },
      viewport: { width: 280, height: 360 },
      preferredPlacement: 'bottom',
      alignment: 'start',
      gap: 8,
      margin: 12
    }),
    {
      top: 12,
      left: 12,
      width: 256,
      maxHeight: 280,
      placement: 'top'
    }
  )
})

test('keeps the preferred placement when the dropdown fits', () => {
  assert.deepEqual(
    resolveFloatingPanelLayout({
      anchor: { top: 80, right: 220, bottom: 112, left: 120 },
      panel: { width: 300, height: 200 },
      viewport: { width: 1024, height: 768 },
      preferredPlacement: 'bottom',
      alignment: 'start'
    }),
    {
      top: 120,
      left: 120,
      width: 300,
      maxHeight: 200,
      placement: 'bottom'
    }
  )
})

test('shifts a start-aligned dropdown away from the right edge', () => {
  assert.deepEqual(
    resolveFloatingPanelLayout({
      anchor: { top: 100, right: 740, bottom: 132, left: 700 },
      panel: { width: 220, height: 160 },
      viewport: { width: 760, height: 500 },
      preferredPlacement: 'bottom',
      alignment: 'start'
    }),
    {
      top: 140,
      left: 528,
      width: 220,
      maxHeight: 160,
      placement: 'bottom'
    }
  )
})

test('flips a top dropdown below an anchor near the top edge', () => {
  assert.deepEqual(
    resolveFloatingPanelLayout({
      anchor: { top: 30, right: 180, bottom: 60, left: 100 },
      panel: { width: 240, height: 240 },
      viewport: { width: 500, height: 500 },
      preferredPlacement: 'top',
      alignment: 'start'
    }),
    {
      top: 68,
      left: 100,
      width: 240,
      maxHeight: 240,
      placement: 'bottom'
    }
  )
})

test('uses the larger side and caps height when neither side fits', () => {
  assert.deepEqual(
    resolveFloatingPanelLayout({
      anchor: { top: 250, right: 280, bottom: 280, left: 200 },
      panel: { width: 292, height: 640 },
      viewport: { width: 500, height: 500 },
      preferredPlacement: 'bottom',
      alignment: 'center'
    }),
    {
      top: 12,
      left: 94,
      width: 292,
      maxHeight: 230,
      placement: 'top'
    }
  )
})

test('keeps a flipped dropdown inside both viewport margins', () => {
  assert.deepEqual(
    resolveFloatingPanelLayout({
      anchor: { top: 224, right: 140, bottom: 224, left: 140 },
      panel: { width: 340, height: 500 },
      viewport: { width: 150, height: 225 },
      preferredPlacement: 'top',
      alignment: 'start'
    }),
    {
      top: 12,
      left: 12,
      width: 126,
      maxHeight: 201,
      placement: 'top'
    }
  )
})
