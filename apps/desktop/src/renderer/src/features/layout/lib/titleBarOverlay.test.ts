import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTitleBarOverlayAppearance } from './titleBarOverlay.ts'

test('caption glyphs follow the theme ink token', () => {
  assert.equal(resolveTitleBarOverlayAppearance('45 45 43', 1)?.symbolColor, '#2d2d2b')
  assert.equal(resolveTitleBarOverlayAppearance(' 238 241 242 ', 1)?.symbolColor, '#eef1f2')
})

test('caption band height tracks the UI zoom applied to the top bar', () => {
  assert.equal(resolveTitleBarOverlayAppearance('0 0 0', 1)?.height, 48)
  assert.equal(resolveTitleBarOverlayAppearance('0 0 0', 16 / 14)?.height, 55)
  assert.equal(resolveTitleBarOverlayAppearance('0 0 0', 12 / 14)?.height, 41)
  assert.equal(resolveTitleBarOverlayAppearance('0 0 0', Number.NaN)?.height, 48)
})

test('unresolved or malformed ink tokens produce no update', () => {
  assert.equal(resolveTitleBarOverlayAppearance('', 1), null)
  assert.equal(resolveTitleBarOverlayAppearance('45 45', 1), null)
  assert.equal(resolveTitleBarOverlayAppearance('45 45 300', 1), null)
})
