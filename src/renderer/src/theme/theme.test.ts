import assert from 'node:assert/strict'
import test from 'node:test'

import { alpha, solid, theme } from './theme.ts'

test('theme color helpers emit normalized rgb var references', () => {
  assert.equal(solid('accent'), 'rgb(var(--yachiyo-rgb-accent))')
  assert.equal(alpha('accent', 0.12), 'rgb(var(--yachiyo-rgb-accent) / 0.12)')
  assert.equal(alpha('ink', 0.08), 'rgb(var(--yachiyo-rgb-ink) / 0.08)')
})

test('theme exposes semantic tokens for accent and danger independently', () => {
  assert.equal(theme.text.accent, 'rgb(var(--yachiyo-rgb-accent))')
  assert.equal(theme.text.danger, 'rgb(var(--yachiyo-rgb-danger))')
  assert.notEqual(theme.text.accent, theme.text.danger)
  assert.equal(theme.background.accentSurface, 'rgb(var(--yachiyo-rgb-accent) / 0.12)')
  assert.equal(theme.background.dangerSurface, 'rgb(var(--yachiyo-rgb-danger) / 0.08)')
})

test('theme rejects invalid alpha values', () => {
  assert.throws(() => alpha('accent', -0.01), /between 0 and 1/)
  assert.throws(() => alpha('accent', 1.01), /between 0 and 1/)
})
