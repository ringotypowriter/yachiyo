import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import type {
  EventLoopDelayStats,
  PerfStatsResponse,
  RunPerfRecord
} from '../../../shared/yachiyo/protocol.ts'

const MAX_RECENT_RUNS = 50
const IPC_WINDOW_MS = 60_000

interface TimestampedEvent {
  type: string
  at: number
}

export interface PerfMonitor {
  recordRun(record: RunPerfRecord): void
  recordIpcEvent(type: string): void
  setActiveRunCount(count: number): void
  getStats(): PerfStatsResponse
  stop(): void
}

export interface RunPerfCollector {
  /** Call around each recovery checkpoint write */
  recordCheckpointWrite(durationMs: number): void
  /** Call around each tool call DB write (create or update) */
  recordToolCallWrite(durationMs: number): void
  /** Call on each text delta emission */
  recordDeltaEvent(): void
  /** Call on each reasoning delta emission */
  recordReasoningDeltaEvent(): void
  /** Add to total text chars streamed */
  addTextChars(count: number): void
  /** Finalize and report the record to the global perfMonitor */
  finish(threadId: string): void
}

// The histogram reports total delay from scheduling to firing, which includes
// the resolution interval itself. We subtract the resolution so displayed
// values reflect actual event loop lag, not the timer baseline.
const EL_RESOLUTION_MS = 10

function createPerfMonitor(): PerfMonitor {
  const startedAt = Date.now()

  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: EL_RESOLUTION_MS })
  histogram.enable()

  const recentRuns: RunPerfRecord[] = []
  let activeRunCount = 0
  let totalIpcEvents = 0
  const recentIpcEvents: TimestampedEvent[] = []

  function pruneIpcWindow(): void {
    const cutoff = Date.now() - IPC_WINDOW_MS
    while (recentIpcEvents.length > 0 && recentIpcEvents[0].at < cutoff) {
      recentIpcEvents.shift()
    }
  }

  function elLag(ns: number): number {
    return Math.max(0, nsToMs(ns) - EL_RESOLUTION_MS)
  }

  function getEventLoopStats(): EventLoopDelayStats {
    return {
      min: elLag(histogram.min),
      max: elLag(histogram.max),
      mean: elLag(histogram.mean),
      p50: elLag(histogram.percentile(50)),
      p95: elLag(histogram.percentile(95)),
      p99: elLag(histogram.percentile(99)),
      samples: histogram.exceeds
    }
  }

  return {
    recordRun(record: RunPerfRecord): void {
      recentRuns.unshift(record)
      if (recentRuns.length > MAX_RECENT_RUNS) {
        recentRuns.length = MAX_RECENT_RUNS
      }
    },

    recordIpcEvent(type: string): void {
      totalIpcEvents++
      recentIpcEvents.push({ type, at: Date.now() })
    },

    setActiveRunCount(count: number): void {
      activeRunCount = count
    },

    getStats(): PerfStatsResponse {
      pruneIpcWindow()

      const byType: Record<string, number> = {}
      for (const evt of recentIpcEvents) {
        byType[evt.type] = (byType[evt.type] ?? 0) + 1
      }

      return {
        eventLoop: getEventLoopStats(),
        recentRuns: [...recentRuns],
        ipcEventCount: totalIpcEvents,
        ipcEventsLast60s: recentIpcEvents.length,
        ipcEventsByType: byType,
        activeRunCount,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
      }
    },

    stop(): void {
      histogram.disable()
    }
  }
}

function nsToMs(ns: number): number {
  return Math.round((ns / 1_000_000) * 100) / 100
}

// ── Module singleton ──────────────────────────────────────────────────

let instance: PerfMonitor | null = null

export function getPerfMonitor(): PerfMonitor {
  if (!instance) {
    instance = createPerfMonitor()
  }
  return instance
}

export function stopPerfMonitor(): void {
  instance?.stop()
  instance = null
}

// ── Per-run collector ─────────────────────────────────────────────────

export function createRunPerfCollector(runId: string): RunPerfCollector {
  const startedAt = Date.now()
  let checkpointWriteCount = 0
  let checkpointWriteTotalMs = 0
  let checkpointWriteMaxMs = 0
  let toolCallWriteCount = 0
  let toolCallWriteTotalMs = 0
  let deltaEventCount = 0
  let reasoningDeltaEventCount = 0
  let textCharsStreamed = 0

  return {
    recordCheckpointWrite(durationMs: number): void {
      checkpointWriteCount++
      checkpointWriteTotalMs += durationMs
      if (durationMs > checkpointWriteMaxMs) checkpointWriteMaxMs = durationMs
    },

    recordToolCallWrite(durationMs: number): void {
      toolCallWriteCount++
      toolCallWriteTotalMs += durationMs
    },

    recordDeltaEvent(): void {
      deltaEventCount++
    },

    recordReasoningDeltaEvent(): void {
      reasoningDeltaEventCount++
    },

    addTextChars(count: number): void {
      textCharsStreamed += count
    },

    finish(threadId: string): void {
      const record: RunPerfRecord = {
        runId,
        threadId,
        durationMs: Date.now() - startedAt,
        checkpointWriteCount,
        checkpointWriteTotalMs: Math.round(checkpointWriteTotalMs * 100) / 100,
        checkpointWriteMaxMs: Math.round(checkpointWriteMaxMs * 100) / 100,
        toolCallWriteCount,
        toolCallWriteTotalMs: Math.round(toolCallWriteTotalMs * 100) / 100,
        deltaEventCount,
        reasoningDeltaEventCount,
        textCharsStreamed,
        completedAt: new Date().toISOString()
      }
      getPerfMonitor().recordRun(record)
    }
  }
}
