export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [min, hour, , , dow] = parts
  const pad = (n: string): string => n.padStart(2, '0')

  if (min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} min`
  if (!min.includes('*') && !min.includes('/') && hour === '*') return `Every hour at :${pad(min)}`
  if (
    !min.includes('*') &&
    !min.includes('/') &&
    !hour.includes('*') &&
    !hour.includes('/') &&
    dow === '*'
  )
    return `Daily at ${pad(hour)}:${pad(min)}`
  if (!min.includes('*') && !hour.includes('*') && dow === '1-5')
    return `Weekdays at ${pad(hour)}:${pad(min)}`
  if (!min.includes('*') && !hour.includes('*') && /^[\d,]+$/.test(dow)) {
    const dayNames = dow
      .split(',')
      .map((d) => DAY_LABELS[parseInt(d)] ?? d)
      .join(', ')
    return `${dayNames} at ${pad(hour)}:${pad(min)}`
  }

  return cron
}
