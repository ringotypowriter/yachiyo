import type { AppLogEntry, AppLogLevel, ReadAppLogsResult } from '@yachiyo/shared/appLogs'

export type LogLevelFilter = 'all' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<AppLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  verbose: 3,
  debug: 4,
  silly: 5
}

const FILTER_MAX_RANK: Record<LogLevelFilter, number> = {
  all: Number.POSITIVE_INFINITY,
  info: LEVEL_RANK.info,
  warn: LEVEL_RANK.warn,
  error: LEVEL_RANK.error
}

export const MAX_RETAINED_LOG_ENTRIES = 5000

export function filterAppLogEntries(
  entries: readonly AppLogEntry[],
  filter: { level: LogLevelFilter; query: string }
): AppLogEntry[] {
  const maxRank = FILTER_MAX_RANK[filter.level]
  const query = filter.query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (LEVEL_RANK[entry.level] > maxRank) return false
    if (query === '') return true
    return (
      entry.message.toLowerCase().includes(query) || entry.timestamp.toLowerCase().includes(query)
    )
  })
}

export function mergeAppLogReads(
  existing: AppLogEntry[],
  result: ReadAppLogsResult,
  maxEntries: number = MAX_RETAINED_LOG_ENTRIES
): AppLogEntry[] {
  if (result.reset) return result.entries.slice(-maxEntries)
  if (result.entries.length === 0) return existing
  return [...existing, ...result.entries].slice(-maxEntries)
}
