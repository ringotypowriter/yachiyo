import type { ActivitySnapshot, ActivitySourceEntry } from '@yachiyo/shared/protocol'

interface Span extends ActivitySourceEntry {
  startMs: number
  endMs: number
}

export type ActivitySummaryEntry = ActivitySourceEntry

export interface ActivitySummary {
  /** Human-readable summary for injection into the LLM turn context. */
  text: string
  /** Start of tracking session (ISO). */
  startedAt: string
  /** End of tracking session (ISO). */
  endedAt: string
  /** Duration in milliseconds. */
  totalDurationMs: number
  /** Number of unique apps visited. */
  uniqueApps: number
  /** Time where user input was idle long enough to treat foreground activity as AFK. */
  afkDurationMs?: number
  /** Aggregated activity entries, sorted by duration descending. */
  entries: ActivitySummaryEntry[]
  /** Low-frequency window text snapshots captured while Yachiyo was blurred. */
  snapshots?: ActivitySnapshot[]
}

/** Max distinct entries in the summary text. Remaining entries are collapsed. */
const MAX_OUTPUT_ENTRIES = 10

/**
 * Merge consecutive spans with the same (bundleId + windowTitle).
 * The tracker already collapses consecutive identical samples into spans;
 * this handles non-consecutive repeats of the same key across the session.
 */
function aggregateSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return []

  const byKey = new Map<string, Span>()
  for (const span of spans) {
    const key = `${span.bundleId}|${span.windowTitle ?? ''}`
    const existing = byKey.get(key)
    if (existing) {
      existing.endMs = span.endMs
      existing.durationMs += span.durationMs
      if (span.inputIdleDurationMs !== undefined) {
        existing.inputIdleDurationMs =
          (existing.inputIdleDurationMs ?? 0) + span.inputIdleDurationMs
      }
    } else {
      byKey.set(key, { ...span })
    }
  }

  return [...byKey.values()].sort((a, b) => b.durationMs - a.durationMs)
}

/** Format milliseconds as a human-readable duration. */
export function formatActivityDuration(ms: number): string {
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remaining = secs % 60
  if (remaining === 0) return `${mins}min`
  return `${mins}min ${remaining}s`
}

/**
 * Summarize tracked spans into a compact ActivitySummary.
 * The `text` field is what gets injected into the LLM turn context —
 * keep it natural and free of internal metrics.
 */
export function summarizeSpans(
  spans: Span[],
  trackingStartMs: number,
  trackingEndMs: number,
  options?: { afkDurationMs?: number; snapshots?: ActivitySnapshot[] }
): ActivitySummary | null {
  if (spans.length === 0) return null

  const aggregated = aggregateSpans(spans)
  const totalDurationMs = trackingEndMs - trackingStartMs
  const uniqueApps = new Set(spans.map((s) => s.bundleId)).size
  const afkDurationMs = options?.afkDurationMs
  const snapshots = (options?.snapshots ?? []).filter((snapshot) => snapshot.ocr?.excerpt)

  const entries = aggregated.slice(0, MAX_OUTPUT_ENTRIES)
  const truncated = aggregated.length - MAX_OUTPUT_ENTRIES
  const summaryEntries = aggregated.map((entry) => ({
    appName: entry.appName,
    bundleId: entry.bundleId,
    ...(entry.windowTitle ? { windowTitle: entry.windowTitle } : {}),
    durationMs: entry.durationMs,
    ...(entry.inputIdleDurationMs !== undefined
      ? { inputIdleDurationMs: entry.inputIdleDurationMs }
      : {})
  }))

  const lines: string[] = []
  lines.push(
    `Between Yachiyo's last work and now (${formatActivityDuration(totalDurationMs)} total), tracked foreground activity data:`
  )
  lines.push('<activity_summary>')

  for (const entry of entries) {
    lines.push(
      JSON.stringify({
        appName: entry.appName,
        bundleId: entry.bundleId,
        ...(entry.windowTitle ? { windowTitle: entry.windowTitle } : {}),
        duration: formatActivityDuration(entry.durationMs),
        ...(entry.inputIdleDurationMs !== undefined
          ? { inputIdleDuration: formatActivityDuration(entry.inputIdleDurationMs) }
          : {})
      })
    )
  }

  if (afkDurationMs !== undefined && afkDurationMs > 0) {
    lines.push(
      JSON.stringify({
        status: 'afk',
        duration: formatActivityDuration(afkDurationMs)
      })
    )
  }

  if (snapshots.length > 0) {
    lines.push(JSON.stringify({ windowTextSnapshotCount: snapshots.length }))
  }

  if (truncated > 0) {
    lines.push(JSON.stringify({ omittedEntries: truncated }))
  }

  lines.push('</activity_summary>')
  lines.push('')
  lines.push(
    'Durations describe foreground windows, not confirmed attention or playback. Input idle overlaps foreground time and does not mean the user was away. The total is the elapsed record interval, not viewing time.'
  )

  return {
    text: lines.join('\n'),
    startedAt: new Date(trackingStartMs).toISOString(),
    endedAt: new Date(trackingEndMs).toISOString(),
    totalDurationMs,
    uniqueApps,
    entries: summaryEntries,
    ...(snapshots.length > 0 ? { snapshots } : {}),
    ...(afkDurationMs !== undefined && afkDurationMs > 0 ? { afkDurationMs } : {})
  }
}
