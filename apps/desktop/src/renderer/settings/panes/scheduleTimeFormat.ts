import type { Locale } from '@yachiyo/i18n/index'

type Translate = typeof import('@yachiyo/i18n/index').t

export function weekdayLabels(locale: Locale, width: 'narrow' | 'short'): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: width, timeZone: 'UTC' })
  // 2024-01-07 is a Sunday, so day index 0..6 maps to Sun..Sat.
  return Array.from({ length: 7 }, (_, day) => format.format(Date.UTC(2024, 0, 7 + day)))
}

export function cronToHuman(cron: string, t: Translate, locale: Locale): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [min, hour, , , dow] = parts
  const pad = (n: string): string => n.padStart(2, '0')
  const time = `${pad(hour)}:${pad(min)}`

  if (min.startsWith('*/') && hour === '*') {
    return t('settings.schedule.cron.everyMinutes', { minutes: min.slice(2) })
  }
  if (!min.includes('*') && !min.includes('/') && hour === '*') {
    return t('settings.schedule.cron.everyHourAt', { minute: pad(min) })
  }
  if (
    !min.includes('*') &&
    !min.includes('/') &&
    !hour.includes('*') &&
    !hour.includes('/') &&
    dow === '*'
  ) {
    return t('settings.schedule.cron.dailyAt', { time })
  }
  if (!min.includes('*') && !hour.includes('*') && dow === '1-5') {
    return t('settings.schedule.cron.weekdaysAt', { time })
  }
  if (!min.includes('*') && !hour.includes('*') && /^[\d,]+$/.test(dow)) {
    const labels = weekdayLabels(locale, 'short')
    const dayNames = dow
      .split(',')
      .map((d) => labels[parseInt(d)] ?? d)
      .join(', ')
    return t('settings.schedule.cron.daysAt', { days: dayNames, time })
  }

  return cron
}
