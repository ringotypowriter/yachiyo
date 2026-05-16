import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_THEME_APPEARANCE,
  DEFAULT_THEME_ID,
  alpha,
  resolveThemeAttributes,
  solid,
  theme
} from './theme.ts'

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
  assert.equal(theme.background.sidebarVibrancy, 'rgb(var(--yachiyo-rgb-accent) / 0.15)')
  assert.equal(theme.background.scrim, 'rgb(var(--yachiyo-rgb-scrim) / 0.25)')
  assert.equal(theme.background.onAccentOverlay, 'rgb(var(--yachiyo-rgb-on-accent-overlay) / 0.15)')
})

test('theme rejects invalid alpha values', () => {
  assert.throws(() => alpha('accent', -0.01), /between 0 and 1/)
  assert.throws(() => alpha('accent', 1.01), /between 0 and 1/)
})

test('theme resolver keeps Mizu as the default theme and follows system appearance', () => {
  assert.deepEqual(resolveThemeAttributes(undefined, false), {
    themeId: DEFAULT_THEME_ID,
    appearance: DEFAULT_THEME_APPEARANCE,
    variant: 'light'
  })

  assert.deepEqual(resolveThemeAttributes(undefined, true), {
    themeId: DEFAULT_THEME_ID,
    appearance: DEFAULT_THEME_APPEARANCE,
    variant: 'dark'
  })
})

test('theme resolver lets explicit appearance override the system variant', () => {
  assert.deepEqual(resolveThemeAttributes({ themeAppearance: 'dark' }, false), {
    themeId: 'mizu',
    appearance: 'dark',
    variant: 'dark'
  })

  assert.deepEqual(resolveThemeAttributes({ themeAppearance: 'light' }, true), {
    themeId: 'mizu',
    appearance: 'light',
    variant: 'light'
  })
})
