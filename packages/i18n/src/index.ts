import { createI18n } from './core.ts'
import { en } from './locales/en/index.ts'
import { zhCN } from './locales/zh-CN/index.ts'

export {
  resolveLocale,
  SUPPORTED_LOCALES,
  type DateStyle,
  type LanguageSetting,
  type Locale,
  type MessageParams
} from './core.ts'

export type AppCatalog = typeof en

export const i18n = createI18n({ en, 'zh-CN': zhCN })

export const { t, tPlural, formatDate, formatNumber, setLocale, getLocale, onLocaleChange } = i18n
