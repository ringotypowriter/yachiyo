import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAuxiliaryWindowOptions, buildMainWindowOptions } from './windowOptions.ts'

test('macOS main window preserves hiddenInset, traffic lights, and vibrancy', () => {
  const options = buildMainWindowOptions('darwin')

  assert.equal(options.titleBarStyle, 'hiddenInset')
  assert.deepEqual(options.trafficLightPosition, { x: 14, y: 15 })
  assert.ok(options.vibrancy)
  assert.equal(options.titleBarOverlay, undefined)
})

test('Windows main window uses native caption controls without macOS-only keys', () => {
  const options = buildMainWindowOptions('win32')

  assert.equal(options.titleBarStyle, 'hidden')
  assert.ok(options.titleBarOverlay)
  assert.equal('trafficLightPosition' in options, false)
  assert.equal('vibrancy' in options, false)
  assert.equal('visualEffectState' in options, false)
})

test('Windows auxiliary windows are opaque, closable, and absent from the taskbar', () => {
  const options = buildAuxiliaryWindowOptions('win32')

  assert.equal(options.transparent, false)
  assert.equal(options.skipTaskbar, true)
  assert.ok(options.backgroundColor)
  assert.notEqual(options.closable, false)
})
