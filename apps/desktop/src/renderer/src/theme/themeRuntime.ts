import type { SettingsConfig, ThemeAppearance, ThemeId } from '@yachiyo/shared/protocol'
import {
  DEFAULT_THEME_APPEARANCE,
  DEFAULT_THEME_ID,
  getThemePalette,
  resolveThemeAttributes,
  themeRgbTokenVars,
  type ThemeAttributes
} from './theme.ts'

const THEME_ID_STORAGE_KEY = 'yachiyo-theme-id'
const THEME_APPEARANCE_STORAGE_KEY = 'yachiyo-theme-appearance'
const COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)'

type ThemeGeneralConfig = Pick<
  NonNullable<SettingsConfig['general']>,
  'themeId' | 'themeAppearance'
>

function getSystemPrefersDark(): boolean {
  return globalThis.matchMedia?.(COLOR_SCHEME_QUERY).matches === true
}

function readStoredThemePreference(): ThemeGeneralConfig | undefined {
  const themeId = globalThis.localStorage?.getItem(THEME_ID_STORAGE_KEY)
  const themeAppearance = globalThis.localStorage?.getItem(THEME_APPEARANCE_STORAGE_KEY)
  if (themeId == null && themeAppearance == null) {
    return undefined
  }

  const preference: Partial<ThemeGeneralConfig> = {}
  if (themeId !== null && themeId !== undefined) {
    preference.themeId = themeId as ThemeId
  }
  if (themeAppearance !== null && themeAppearance !== undefined) {
    preference.themeAppearance = themeAppearance as ThemeAppearance
  }
  return preference
}

function rememberThemePreference(attributes: ThemeAttributes): void {
  globalThis.localStorage?.setItem(THEME_ID_STORAGE_KEY, attributes.themeId)
  globalThis.localStorage?.setItem(THEME_APPEARANCE_STORAGE_KEY, attributes.appearance)
}

export function applyThemeAttributes(attributes: ThemeAttributes): void {
  const root = document.documentElement
  const palette = getThemePalette(attributes.themeId, attributes.variant)
  for (const token of Object.keys(themeRgbTokenVars) as Array<keyof typeof themeRgbTokenVars>) {
    root.style.setProperty(themeRgbTokenVars[token], palette[token])
  }
  root.dataset['yachiyoTheme'] = attributes.themeId
  root.dataset['yachiyoThemeAppearance'] = attributes.appearance
  root.dataset['yachiyoThemeVariant'] = attributes.variant
  root.classList.toggle('dark', attributes.variant === 'dark')
  root.style.colorScheme = attributes.variant
}

export function applyThemeConfig(
  config: Pick<SettingsConfig, 'general'>,
  options: { remember?: boolean } = {}
): void {
  const attributes = resolveThemeAttributes(config?.general, getSystemPrefersDark())
  applyThemeAttributes(attributes)
  if (options.remember !== false) {
    rememberThemePreference(attributes)
  }
}

export function applyStoredThemePreference(): void {
  applyThemeAttributes(resolveThemeAttributes(readStoredThemePreference(), getSystemPrefersDark()))
}

export function subscribeToSystemThemeChanges(onChange: () => void): () => void {
  const media = globalThis.matchMedia?.(COLOR_SCHEME_QUERY)
  if (!media) {
    return () => {}
  }

  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export function subscribeToConfigThemeChanges(
  onChange: (config: SettingsConfig) => void
): () => void {
  return window.api.yachiyo.subscribe((event) => {
    if (event.type === 'settings.updated') {
      onChange(event.config)
    }
  })
}

export { DEFAULT_THEME_APPEARANCE, DEFAULT_THEME_ID }
