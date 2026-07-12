import { useSyncExternalStore } from 'react'
import type { Locale } from './core.ts'
import { i18n, t } from './index.ts'

export function useLocale(): Locale {
  return useSyncExternalStore(i18n.onLocaleChange, i18n.getLocale)
}

export function useT(): typeof t {
  useLocale()
  return t
}
