interface Span {
  appName: string
  bundleId: string
  windowTitle?: string
  startMs: number
  endMs: number
  durationMs: number
}

export interface ActivitySummary {
  /** Human-readable summary for injection into the LLM turn context. */
  text: string
  /** Start of tracking session (ISO). */
  startedAt: string
  /** Duration in milliseconds. */
  totalDurationMs: number
  /** Number of unique apps visited. */
  uniqueApps: number
  /** Time where user input was idle long enough to treat foreground activity as AFK. */
  afkDurationMs?: number
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
  options?: { afkDurationMs?: number }
): ActivitySummary | null {
  if (spans.length === 0) return null

  const aggregated = aggregateSpans(spans)
  const totalDurationMs = trackingEndMs - trackingStartMs
  const uniqueApps = new Set(spans.map((s) => s.bundleId)).size
  const afkDurationMs = options?.afkDurationMs

  const entries = aggregated.slice(0, MAX_OUTPUT_ENTRIES)
  const truncated = aggregated.length - MAX_OUTPUT_ENTRIES

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
        duration: formatActivityDuration(entry.durationMs)
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

  if (truncated > 0) {
    lines.push(JSON.stringify({ omittedEntries: truncated }))
  }

  lines.push('</activity_summary>')
  lines.push('')
  lines.push('This may help you understand what the user was working on before returning.')

  return {
    text: lines.join('\n'),
    startedAt: new Date(trackingStartMs).toISOString(),
    totalDurationMs,
    uniqueApps,
    ...(afkDurationMs !== undefined && afkDurationMs > 0 ? { afkDurationMs } : {})
  }
}
