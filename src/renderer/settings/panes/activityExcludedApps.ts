import type { ActivitySourceRecord } from '../../../shared/yachiyo/protocol.ts'

export interface RecentActivityAppOption {
  key: string
  appName: string
  bundleId: string
  totalDurationMs: number
}

function normalizeAppIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export function parseExcludedAppTokens(value: string): string[] {
  const seen = new Set<string>()
  const apps: string[] = []

  for (const item of value.split(/[\n,]/u)) {
    const app = item.trim()
    const key = normalizeAppIdentifier(app)
    if (!app || seen.has(key)) continue
    seen.add(key)
    apps.push(app)
  }

  return apps
}

export function addExcludedApp(existing: string[], value: string): string[] {
  const additions = parseExcludedAppTokens(value)
  const seen = new Set(existing.map(normalizeAppIdentifier))
  const next = [...existing]

  for (const app of additions) {
    const key = normalizeAppIdentifier(app)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(app)
  }

  return next
}

export function removeExcludedApp(existing: string[], value: string): string[] {
  const key = normalizeAppIdentifier(value)
  return existing.filter((app) => normalizeAppIdentifier(app) !== key)
}

export function isAppExcluded(appName: string, bundleId: string, excludedApps: string[]): boolean {
  const appNameKey = normalizeAppIdentifier(appName)
  const bundleIdKey = normalizeAppIdentifier(bundleId)
  return excludedApps.some((app) => {
    const key = normalizeAppIdentifier(app)
    return key === appNameKey || key === bundleIdKey
  })
}

export function buildRecentActivityAppOptions(
  records: ActivitySourceRecord[],
  excludedApps: string[]
): RecentActivityAppOption[] {
  const byBundleId = new Map<string, RecentActivityAppOption>()

  for (const record of records) {
    for (const entry of record.entries) {
      if (!entry.appName || !entry.bundleId) continue
      if (isAppExcluded(entry.appName, entry.bundleId, excludedApps)) continue

      const key = normalizeAppIdentifier(entry.bundleId)
      const existing = byBundleId.get(key)
      if (existing) {
        existing.totalDurationMs += entry.durationMs
        continue
      }

      byBundleId.set(key, {
        key,
        appName: entry.appName,
        bundleId: entry.bundleId,
        totalDurationMs: entry.durationMs
      })
    }
  }

  return Array.from(byBundleId.values()).sort(
    (left, right) =>
      right.totalDurationMs - left.totalDurationMs || left.appName.localeCompare(right.appName)
  )
}
