import type {
  ActivityOcrConfig,
  ActivitySnapshot,
  ActivitySnapshotTrigger
} from '../../../shared/yachiyo/protocol.ts'
import { shouldCaptureOcrForSample } from './ActivityOcrPolicy.ts'
import { summarizeSpans, type ActivitySummary } from './ActivitySummarizer.ts'
import { sampleActivity, probeFullActivityAccess, type SampleResult } from './osascript.ts'

export type { ActivitySummary } from './ActivitySummarizer.ts'

export type ActivityTrackingMode = 'off' | 'simple' | 'full'

export interface ActivityTrackerDeps {
  sampleActivity: (mode: 'simple' | 'full') => Promise<SampleResult | null>
  checkAccessibilityPermission: () => Promise<boolean>
  captureOcrSnapshot?: (
    sample: SampleResult,
    trigger: ActivitySnapshotTrigger
  ) => Promise<ActivitySnapshot | null>
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval: (timer: ReturnType<typeof setInterval>) => void
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
  now: () => number
  getIdleTimeMs: () => number
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
const AFK_IDLE_THRESHOLD_MS = 5 * 60_000
const OCR_INITIAL_DELAY_MS = 30_000
const OCR_LONG_SESSION_INTERVAL_MS = 10 * 60_000
const OCR_MIN_WINDOW_DWELL_MS = 3 * 60_000
const OCR_MAX_PER_ACTIVITY_RECORD = 2

const DEFAULT_DEPS: ActivityTrackerDeps = {
  sampleActivity,
  checkAccessibilityPermission: probeFullActivityAccess,
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  now: () => Date.now(),
  getIdleTimeMs: () => 0
}

function sampleWindowKey(sample: SampleResult): string {
  return `${sample.bundleId}|${sample.windowTitle ?? ''}`
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
  private initialOcrTimer: ReturnType<typeof setTimeout> | null = null
  private spans: Span[] = []
  private currentSpan: Span | null = null
  private snapshots: ActivitySnapshot[] = []
  private latestSummary: ActivitySummary | null = null
  /** Accumulated session start. Reset only when consumed or mode turned off. */
  private trackingStartTime: number | null = null
  private afkStartTime: number | null = null
  private afkDurationMs = 0
  private fullModeAvailable: boolean | null = null
  private isWindowBlurred = false
  private isPolling = false
  private isCapturingOcr = false
  private lastOcrAt: number | null = null
  private currentWindowKey: string | null = null
  private windowDwellStartMs: number | null = null
  private readonly deps: ActivityTrackerDeps
  private getIdleTimeMs: () => number
  private captureOcrSnapshot?: ActivityTrackerDeps['captureOcrSnapshot']
  private ocrConfig: ActivityOcrConfig = { enabled: false, excludedApps: [] }

  constructor(initialMode: ActivityTrackingMode, deps: ActivityTrackerDeps = DEFAULT_DEPS) {
    this.mode = initialMode
    this.deps = deps
    this.getIdleTimeMs = deps.getIdleTimeMs
    this.captureOcrSnapshot = deps.captureOcrSnapshot
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

  setIdleTimeProvider(getIdleTimeMs: () => number): void {
    this.getIdleTimeMs = getIdleTimeMs
  }

  setOcrSnapshotProvider(provider: ActivityTrackerDeps['captureOcrSnapshot']): void {
    this.captureOcrSnapshot = provider
  }

  setOcrConfig(config: ActivityOcrConfig | undefined): void {
    this.ocrConfig = {
      enabled: config?.enabled === true,
      excludedApps: [...(config?.excludedApps ?? [])]
    }
    if (!this.ocrConfig.enabled) {
      this.cancelInitialOcr()
      return
    }
    if (this.isWindowBlurred) {
      this.scheduleInitialOcr()
    }
  }

  /** Call when ALL Yachiyo windows have lost focus. */
  handleWindowBlur(): void {
    this.isWindowBlurred = true
    if ((this.mode as ActivityTrackingMode) === 'off') return
    this.scheduleInitialOcr()
    if (this.pollTimer) return
    void this.startPolling()
  }

  /** Call when ANY Yachiyo window regains focus. */
  handleWindowFocus(): void {
    this.isWindowBlurred = false
    this.cancelInitialOcr()
    if (this.trackingStartTime != null) {
      this.syncAfkState(this.deps.now())
    }
    this.pausePolling()
  }

  /**
   * Compute a summary from ALL accumulated spans since the last consume,
   * store it, clear accumulated state, and return it.
   * Call this at the start of a new LLM run.
   */
  finalizeAndConsume(): ActivitySummary | null {
    const now = this.deps.now()
    this.cancelInitialOcr()
    if (this.trackingStartTime != null) {
      this.syncAfkState(now)
      this.closeAfkPeriod(now)
    }

    // Close any open span first (in case we're still polling)
    if (this.pollTimer) {
      this.pausePolling()
    }

    if (this.spans.length === 0 || this.trackingStartTime == null) {
      // No data collected — reset stale state so a later session
      // doesn't report an inflated duration.
      this.clearAccumulatedState()
      this.latestSummary = null
      return null
    }

    const summary = summarizeSpans(this.spans, this.trackingStartTime, now, {
      afkDurationMs: this.afkDurationMs,
      snapshots: this.snapshots
    })
    this.latestSummary = summary
    this.clearAccumulatedState()
    return summary
  }

  /** Returns the summary produced by the last finalizeAndConsume(), or null. */
  getLatestSummary(): ActivitySummary | null {
    return this.latestSummary
  }

  // ---- internals ----

  private resetState(): void {
    this.cancelInitialOcr()
    if (this.pollTimer) {
      this.deps.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.clearAccumulatedState()
    this.latestSummary = null
  }

  private clearAccumulatedState(): void {
    this.spans = []
    this.currentSpan = null
    this.snapshots = []
    this.trackingStartTime = null
    this.afkStartTime = null
    this.afkDurationMs = 0
    this.lastOcrAt = null
    this.currentWindowKey = null
    this.windowDwellStartMs = null
  }

  private cancelInitialOcr(): void {
    if (!this.initialOcrTimer) return
    this.deps.clearTimeout(this.initialOcrTimer)
    this.initialOcrTimer = null
  }

  private scheduleInitialOcr(): void {
    if (!this.ocrConfig.enabled) return
    if (!this.captureOcrSnapshot) return
    if (this.initialOcrTimer) return
    this.initialOcrTimer = this.deps.setTimeout(() => {
      this.initialOcrTimer = null
      void this.tryCaptureOcrSnapshot('initial-blur')
    }, OCR_INITIAL_DELAY_MS)
  }

  private pausePolling(): void {
    if (this.pollTimer) {
      this.deps.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    // Close the current span so the gap while focused is not counted
    if (this.currentSpan) {
      this.pushCurrentSpan(this.deps.now())
    }
  }

  private buildClosedCurrentSpan(endMs: number): Span {
    if (!this.currentSpan) {
      throw new Error('Cannot close a missing activity span')
    }
    return {
      ...this.currentSpan,
      endMs,
      durationMs: endMs - this.currentSpan.startMs
    }
  }

  private pushCurrentSpan(endMs: number): void {
    const span = this.buildClosedCurrentSpan(endMs)
    if (span.durationMs > 0) {
      this.spans.push(span)
    }
    this.currentSpan = null
  }

  private syncAfkState(now: number): boolean {
    const idleTimeMs = this.getIdleTimeMs()
    const lastActiveAt = now - idleTimeMs
    if (idleTimeMs < AFK_IDLE_THRESHOLD_MS) {
      this.closeAfkPeriod(lastActiveAt)
      return false
    }

    const sessionStart = this.trackingStartTime ?? lastActiveAt
    const afkStart = Math.max(sessionStart, lastActiveAt)

    if (this.currentSpan) {
      this.pushCurrentSpan(Math.max(this.currentSpan.startMs, afkStart))
    }

    if (this.afkStartTime == null) {
      this.afkStartTime = afkStart
    }
    return true
  }

  private closeAfkPeriod(endMs: number): void {
    if (this.afkStartTime == null) return
    if (endMs > this.afkStartTime) {
      this.afkDurationMs += endMs - this.afkStartTime
    }
    this.afkStartTime = null
  }

  private getEffectiveMode(): 'simple' | 'full' {
    return this.mode === 'full' && this.fullModeAvailable === true ? 'full' : 'simple'
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

    const effectiveMode = this.getEffectiveMode()

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
    if (this.syncAfkState(this.deps.now())) return
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
    if (this.syncAfkState(now)) return
    const key = sampleWindowKey(sample)
    this.updateWindowDwell(key, now)

    if (this.currentSpan) {
      const currentKey = `${this.currentSpan.bundleId}|${this.currentSpan.windowTitle ?? ''}`
      if (key === currentKey) {
        this.currentSpan.endMs = now
        this.currentSpan.durationMs = now - this.currentSpan.startMs
        this.maybeCaptureLongSessionOcr(sample, now)
        return
      }
      this.pushCurrentSpan(now)
    }

    this.currentSpan = {
      appName: sample.appName,
      bundleId: sample.bundleId,
      windowTitle: sample.windowTitle,
      startMs: now,
      endMs: now,
      durationMs: 0
    }
    this.maybeCaptureLongSessionOcr(sample, now)
  }

  private updateWindowDwell(key: string, now: number): void {
    if (this.currentWindowKey === key) return
    this.currentWindowKey = key
    this.windowDwellStartMs = now
  }

  private canCaptureOcrSample(sample: SampleResult): boolean {
    return (
      this.ocrConfig.enabled && shouldCaptureOcrForSample(sample, this.ocrConfig.excludedApps).allow
    )
  }

  private maybeCaptureLongSessionOcr(sample: SampleResult, now: number): void {
    if (!this.ocrConfig.enabled) return
    if (!this.captureOcrSnapshot) return
    if (this.trackingStartTime == null) return
    if (this.snapshots.length >= OCR_MAX_PER_ACTIVITY_RECORD) return
    if (now - this.trackingStartTime < OCR_LONG_SESSION_INTERVAL_MS) return
    if (this.windowDwellStartMs == null) return
    if (now - this.windowDwellStartMs < OCR_MIN_WINDOW_DWELL_MS) return
    if (this.lastOcrAt != null && now - this.lastOcrAt < OCR_LONG_SESSION_INTERVAL_MS) return
    void this.tryCaptureOcrSnapshot('long-session', sample)
  }

  private async tryCaptureOcrSnapshot(
    trigger: ActivitySnapshotTrigger,
    knownSample?: SampleResult
  ): Promise<void> {
    if (!this.ocrConfig.enabled) return
    if (!this.captureOcrSnapshot) return
    if (this.isCapturingOcr) return
    if (!this.isWindowBlurred) return
    if ((this.mode as ActivityTrackingMode) === 'off') return
    if (this.snapshots.length >= OCR_MAX_PER_ACTIVITY_RECORD) return
    const now = this.deps.now()
    if (this.syncAfkState(now)) return

    this.isCapturingOcr = true
    this.lastOcrAt = now
    try {
      const sample = knownSample ?? (await this.deps.sampleActivity(this.getEffectiveMode()))
      if (!sample || !this.canCaptureOcrSample(sample)) return
      const snapshot = await this.captureOcrSnapshot(sample, trigger)
      if (!this.isWindowBlurred || (this.mode as ActivityTrackingMode) === 'off') return
      if (!this.canCaptureOcrSample(sample)) return
      if (!snapshot) return
      const contentHash = snapshot.ocr?.contentHash
      if (
        contentHash &&
        this.snapshots.some((existing) => existing.ocr?.contentHash === contentHash)
      ) {
        return
      }
      this.snapshots.push(snapshot)
    } catch {
      return
    } finally {
      this.isCapturingOcr = false
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
