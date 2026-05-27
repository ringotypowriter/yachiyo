import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_THEME_APPEARANCE,
  DEFAULT_THEME_ID,
  THEME_OPTIONS,
  alpha,
  getThemePalette,
  getThemePreviewSegments,
  getThemeSchemePreviewSegments,
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
  assert.equal(theme.background.sidebarVibrancy, 'rgb(var(--yachiyo-rgb-counter) / 0.08)')
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

test('theme catalog exposes coordinated light and dark preview stripes', () => {
  assert.deepEqual(
    THEME_OPTIONS.map((option) => option.id),
    ['mizu', 'sumi', 'ume', 'aoba', 'mint', 'fuji', 'yamabuki', 'gobyou', 'murasaki']
  )

  for (const option of THEME_OPTIONS) {
    const lightPalette = getThemePalette(option.id, 'light')
    const darkPalette = getThemePalette(option.id, 'dark')
    assert.notEqual(lightPalette.app, darkPalette.app)
    assert.notEqual(lightPalette.accent, darkPalette.accent)

    for (const variant of ['light', 'dark'] as const) {
      const segments = getThemePreviewSegments(option.id, variant)
      assert.equal(
        segments.reduce((total, segment) => total + segment.weight, 0),
        100
      )
      assert.deepEqual(
        segments.map((segment) => segment.rgb),
        [
          getThemePalette(option.id, variant).app,
          getThemePalette(option.id, variant).canvas,
          getThemePalette(option.id, variant).surface,
          getThemePalette(option.id, variant).ink,
          getThemePalette(option.id, variant).accent
        ]
      )
    }
  }
})

test('theme catalog exposes Mint with the requested core color', () => {
  const mint = THEME_OPTIONS.find((option) => option.id === 'mint')

  assert.equal(mint?.label, 'Mint')
  assert.equal(mint?.palettes.light.canvas, '247 253 251')
  assert.equal(mint?.palettes.dark.accent, '161 227 216')
})

test('theme scheme preview uses one balanced line without text-color dominance', () => {
  for (const option of THEME_OPTIONS) {
    const segments = getThemeSchemePreviewSegments(option.id)
    assert.equal(
      segments.reduce((total, segment) => total + segment.weight, 0),
      100
    )
    assert.equal(segments.map((segment) => segment.token as string).includes('ink'), false)
    assert.ok(
      segments
        .filter((segment) => segment.variant === 'dark' && segment.token !== 'accent')
        .reduce((total, segment) => total + segment.weight, 0) <= 24
    )
  }
})
