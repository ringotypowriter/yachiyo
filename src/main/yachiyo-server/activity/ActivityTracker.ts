import { sampleActivity, probeFullActivityAccess, type SampleResult } from './osascript.ts'
import { summarizeSpans, type ActivitySummary } from './ActivitySummarizer.ts'

export type { ActivitySummary } from './ActivitySummarizer.ts'

export type ActivityTrackingMode = 'off' | 'simple' | 'full'

export interface ActivityTrackerDeps {
  sampleActivity: (mode: 'simple' | 'full') => Promise<SampleResult | null>
  checkAccessibilityPermission: () => Promise<boolean>
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval: (timer: ReturnType<typeof setInterval>) => void
  now: () => number
}

interface Span {
  appName: string
  bundleId: string
  windowTitle?: string
  startMs: number
  endMs: number
  durationMs: number
}

const POLL_INTERVAL_MS = 1000

const DEFAULT_DEPS: ActivityTrackerDeps = {
  sampleActivity,
  checkAccessibilityPermission: probeFullActivityAccess,
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
  now: () => Date.now()
}

/**
 * Tracks what the user is doing outside Yachiyo between LLM runs.
 *
 * Spans accumulate across multiple blur→focus cycles until the next
 * LLM run consumes them via finalizeAndConsume(). Focus only pauses
 * the timer; it does not reset or summarize.
 *
 * No Electron dependency — the host wires blur/focus via handleWindowBlur()
 * and handleWindowFocus().
 */
export class ActivityTracker {
  private mode: ActivityTrackingMode
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private spans: Span[] = []
  private currentSpan: Span | null = null
  private latestSummary: ActivitySummary | null = null
  /** Accumulated session start. Reset only when consumed or mode turned off. */
  private trackingStartTime: number | null = null
  private fullModeAvailable: boolean | null = null
  private isWindowBlurred = false
  private isPolling = false
  private readonly deps: ActivityTrackerDeps

  constructor(initialMode: ActivityTrackingMode, deps: ActivityTrackerDeps = DEFAULT_DEPS) {
    this.mode = initialMode
    this.deps = deps
  }

  /** Update the tracking mode at runtime. */
  setMode(mode: ActivityTrackingMode, options?: { fullModeAvailable?: boolean }): void {
    this.mode = mode
    if (mode === 'off') {
      this.resetState()
      return
    }
    // When switching to full mode, re-probe permission (the user may
    // have granted accessibility since the last denied attempt).
    if (mode === 'full') {
      this.fullModeAvailable = options?.fullModeAvailable ?? null
    }
    if (this.isWindowBlurred && !this.pollTimer) {
      void this.startPolling()
    }
  }

  async refreshFullModeAvailability(): Promise<boolean> {
    this.fullModeAvailable = await this.deps.checkAccessibilityPermission()
    return this.fullModeAvailable
  }

  /** Call when ALL Yachiyo windows have lost focus. */
  handleWindowBlur(): void {
    this.isWindowBlurred = true
    if ((this.mode as ActivityTrackingMode) === 'off') return
    if (this.pollTimer) return
    void this.startPolling()
  }

  /** Call when ANY Yachiyo window regains focus. */
  handleWindowFocus(): void {
    this.isWindowBlurred = false
    this.pausePolling()
  }

  /**
   * Compute a summary from ALL accumulated spans since the last consume,
   * store it, clear accumulated state, and return it.
   * Call this at the start of a new LLM run.
   */
  finalizeAndConsume(): ActivitySummary | null {
    // Close any open span first (in case we're still polling)
    if (this.pollTimer) {
      this.pausePolling()
    }

    if (this.spans.length === 0 || this.trackingStartTime == null) {
      // No data collected — reset stale state so a later session
      // doesn't report an inflated duration.
      this.spans = []
      this.currentSpan = null
      this.trackingStartTime = null
      this.latestSummary = null
      return null
    }

    const summary = summarizeSpans(this.spans, this.trackingStartTime, this.deps.now())
    this.latestSummary = summary
    this.spans = []
    this.currentSpan = null
    this.trackingStartTime = null
    return summary
  }

  /** Returns the summary produced by the last finalizeAndConsume(), or null. */
  getLatestSummary(): ActivitySummary | null {
    return this.latestSummary
  }

  // ---- internals ----

  private resetState(): void {
    if (this.pollTimer) {
      this.deps.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.spans = []
    this.currentSpan = null
    this.latestSummary = null
    this.trackingStartTime = null
  }

  private pausePolling(): void {
    if (this.pollTimer) {
      this.deps.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    // Close the current span so the gap while focused is not counted
    if (this.currentSpan) {
      this.spans.push(this.closeCurrentSpan(this.deps.now()))
      this.currentSpan = null
    }
  }

  private closeCurrentSpan(endMs: number): Span {
    if (!this.currentSpan) {
      throw new Error('Cannot close a missing activity span')
    }
    return {
      ...this.currentSpan,
      endMs,
      durationMs: endMs - this.currentSpan.startMs
    }
  }

  private async startPolling(): Promise<void> {
    if ((this.mode as ActivityTrackingMode) === 'off') return
    if (!this.isWindowBlurred) return
    if (this.pollTimer) return

    if (this.mode === 'full' && this.fullModeAvailable === null) {
      this.fullModeAvailable = await this.deps.checkAccessibilityPermission()
      if (
        (this.mode as ActivityTrackingMode) === 'off' ||
        !this.isWindowBlurred ||
        this.pollTimer
      ) {
        return
      }
    }

    const effectiveMode: 'simple' | 'full' =
      this.mode === 'full' && this.fullModeAvailable === true ? 'full' : 'simple'

    // First poll in the session? Record the start time.
    if (this.trackingStartTime == null) {
      this.trackingStartTime = this.deps.now()
    }

    this.pollTimer = this.deps.setInterval(() => {
      void this.poll(effectiveMode)
    }, POLL_INTERVAL_MS)
  }

  private async poll(effectiveMode: 'simple' | 'full'): Promise<void> {
    if (!this.isWindowBlurred) return
    if (this.mode === 'off') return
    if (this.isPolling) return
    this.isPolling = true

    let sample: SampleResult | null = null
    try {
      sample = await this.deps.sampleActivity(effectiveMode)
    } catch {
      return
    } finally {
      this.isPolling = false
    }
    if ((this.mode as ActivityTrackingMode) === 'off') return
    if (!this.isWindowBlurred) return
    if (!sample) return

    const now = this.deps.now()
    const key = `${sample.bundleId}|${sample.windowTitle ?? ''}`

    if (this.currentSpan) {
      const currentKey = `${this.currentSpan.bundleId}|${this.currentSpan.windowTitle ?? ''}`
      if (key === currentKey) {
        this.currentSpan.endMs = now
        this.currentSpan.durationMs = now - this.currentSpan.startMs
        return
      }
      this.spans.push(this.closeCurrentSpan(now))
    }

    this.currentSpan = {
      appName: sample.appName,
      bundleId: sample.bundleId,
      windowTitle: sample.windowTitle,
      startMs: now,
      endMs: now,
      durationMs: 0
    }
  }
}

let singleton: ActivityTracker | null = null

export function getActivityTracker(initialMode: ActivityTrackingMode): ActivityTracker {
  if (!singleton) {
    singleton = new ActivityTracker(initialMode)
  }
  return singleton
}
