export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]
export type LanguageSetting = Locale | 'auto'

export interface PluralMessage {
  one?: string
  other: string
}

export interface CatalogShape {
  [key: string]: string | PluralMessage | CatalogShape
}

export type Messages<T> = {
  [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends PluralMessage
      ? PluralMessage
      : Messages<T[K]>
}

export type MessageKey<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends PluralMessage
      ? never
      : `${K}.${MessageKey<T[K]>}`
}[keyof T & string]

export type PluralKey<T> = {
  [K in keyof T & string]: T[K] extends string
    ? never
    : T[K] extends PluralMessage
      ? K
      : `${K}.${PluralKey<T[K]>}`
}[keyof T & string]

export type MessageParams = Record<string, string | number>

export type DateStyle = 'time' | 'date' | 'dateTime' | 'relative'

export interface I18n<T extends CatalogShape> {
  t(key: MessageKey<T>, params?: MessageParams): string
  tPlural(key: PluralKey<T>, count: number, params?: MessageParams): string
  formatDate(date: Date, style: DateStyle): string
  formatNumber(value: number): string
  setLocale(locale: Locale): void
  getLocale(): Locale
  onLocaleChange(listener: () => void): () => void
}

export function resolveLocale(setting: unknown, systemLocale: string): Locale {
  if (typeof setting === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(setting)) {
    return setting as Locale
  }
  if (systemLocale === 'zh' || systemLocale.startsWith('zh-')) {
    return 'zh-CN'
  }
  return 'en'
}

function isPluralMessage(value: unknown): value is PluralMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PluralMessage).other === 'string'
  )
}

function lookup(catalog: CatalogShape, key: string): string | PluralMessage | undefined {
  let node: CatalogShape[string] | undefined = catalog
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null || isPluralMessage(node)) {
      return undefined
    }
    node = node[segment]
  }
  return typeof node === 'string' || isPluralMessage(node) ? node : undefined
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60]
]

export function createI18n<T extends CatalogShape>(catalogs: {
  en: T
  'zh-CN': Messages<T>
}): I18n<T> {
  let locale: Locale = 'en'
  const listeners = new Set<() => void>()

  const numberFormats = new Map<Locale, Intl.NumberFormat>()
  const dateFormats = new Map<string, Intl.DateTimeFormat>()

  function numberFormat(): Intl.NumberFormat {
    let format = numberFormats.get(locale)
    if (!format) {
      format = new Intl.NumberFormat(locale)
      numberFormats.set(locale, format)
    }
    return format
  }

  function dateFormat(options: Intl.DateTimeFormatOptions, cacheKey: string): Intl.DateTimeFormat {
    const key = `${locale}:${cacheKey}`
    let format = dateFormats.get(key)
    if (!format) {
      format = new Intl.DateTimeFormat(locale, options)
      dateFormats.set(key, format)
    }
    return format
  }

  function interpolate(message: string, params?: MessageParams): string {
    if (!params) return message
    return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      const value = params[name]
      if (value === undefined) return placeholder
      return typeof value === 'number' ? numberFormat().format(value) : value
    })
  }

  function resolveMessage(key: string): string | PluralMessage {
    return lookup(catalogs[locale], key) ?? lookup(catalogs.en, key) ?? key
  }

  return {
    t(key, params) {
      const message = resolveMessage(key)
      return interpolate(typeof message === 'string' ? message : message.other, params)
    },

    tPlural(key, count, params) {
      const message = resolveMessage(key)
      if (typeof message === 'string') {
        return interpolate(message, { count, ...params })
      }
      const category = new Intl.PluralRules(locale).select(count)
      const form = (category === 'one' ? message.one : undefined) ?? message.other
      return interpolate(form, { count, ...params })
    },

    formatDate(date, style) {
      if (style === 'relative') {
        const seconds = (date.getTime() - Date.now()) / 1000
        const magnitude = Math.abs(seconds)
        const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
        for (const [unit, unitSeconds] of RELATIVE_UNITS) {
          if (magnitude >= unitSeconds) {
            return format.format(Math.trunc(seconds / unitSeconds), unit)
          }
        }
        return format.format(Math.trunc(seconds), 'second')
      }
      if (style === 'time') {
        return dateFormat({ timeStyle: 'short' }, 'time').format(date)
      }
      if (style === 'date') {
        return dateFormat({ dateStyle: 'medium' }, 'date').format(date)
      }
      return dateFormat({ dateStyle: 'medium', timeStyle: 'short' }, 'dateTime').format(date)
    },

    formatNumber(value) {
      return numberFormat().format(value)
    },

    setLocale(next) {
      if (next === locale) return
      locale = next
      for (const listener of listeners) {
        listener()
      }
    },

    getLocale() {
      return locale
    },

    onLocaleChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
