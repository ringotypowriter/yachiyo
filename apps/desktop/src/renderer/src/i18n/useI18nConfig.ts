import { useEffect } from 'react'
import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { resolveLocale, setLocale } from '@yachiyo/i18n/index'

export function applyLanguageConfig(
  config: Pick<SettingsConfig, 'general'> | null | undefined
): void {
  if (!config) {
    return
  }
  const locale = resolveLocale(config.general?.language, navigator.language)
  setLocale(locale)
  document.documentElement.lang = locale
}

export function useApplyLanguageConfig(
  config: Pick<SettingsConfig, 'general'> | null | undefined
): void {
  useEffect(() => {
    applyLanguageConfig(config)
  }, [config])
}

export function useAuxiliaryLanguageConfig(): void {
  useEffect(() => {
    let cancelled = false
    void window.api.yachiyo.getConfig().then((config) => {
      if (!cancelled) {
        applyLanguageConfig(config)
      }
    })

    const unsubscribe = window.api.yachiyo.subscribe((event) => {
      if (event.type === 'settings.updated') {
        applyLanguageConfig(event.config)
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
}
