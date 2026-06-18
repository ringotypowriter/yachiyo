/**
 * Background scheduler that turns the manual "Sync Now" action into automatic,
 * relatively real-time syncing.
 *
 * Two complementary triggers:
 *  - Push: a debounced sync runs shortly after a relevant local change (settings
 *    edited, a run finished, a thread mutated) so this device's changes reach
 *    iCloud quickly.
 *  - Pull: a periodic sync runs on an interval so remote changes from other
 *    devices land without needing a local trigger.
 *
 * All runs go through a single-flight gate: at most one sync executes at a time,
 * and any requests that arrive mid-sync collapse into exactly one follow-up run.
 * The actual export/import work (and skipping when sync isn't enabled) lives in
 * the injected `runSync`; this module only owns the timing and coalescing.
 */

const DEFAULT_PULL_INTERVAL_MS = 30_000
const DEFAULT_PUSH_DEBOUNCE_MS = 3_000
const DEFAULT_STARTUP_DELAY_MS = 5_000

/** Event types whose arrival means local data worth pushing has changed. */
export const AUTO_SYNC_TRIGGER_EVENT_TYPES: ReadonlySet<string> = new Set([
  'settings.updated',
  'thread.created',
  'thread.updated',
  'thread.archived',
  'thread.deleted',
  'run.completed',
  'run.failed'
])

/** Minimal timer surface so tests can drive time deterministically. */
export interface AutoSyncClock {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(handler: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const realClock: AutoSyncClock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

export interface AutoSyncSchedulerDeps {
  /**
   * Runs one sync pass. Resolves to whatever status the sync produced (or null
   * when skipped because sync isn't enabled). Rejections are reported to
   * `onError` and never strand the single-flight gate.
   */
  runSync: () => Promise<unknown>
  /** Subscribe to server events; returns an unsubscribe function. */
  subscribe: (listener: (event: { type: string }) => void) => () => void
  /** Override which event types schedule a debounced push. */
  triggerEventTypes?: ReadonlySet<string>
  /** Interval between periodic pull syncs. Defaults to 30s. */
  pullIntervalMs?: number
  /** Quiet period after a local change before pushing. Defaults to 3s. */
  pushDebounceMs?: number
  /** Delay before the catch-up sync that runs once after start. Defaults to 5s. */
  startupDelayMs?: number
  onError?: (error: unknown) => void
  clock?: AutoSyncClock
}

export interface AutoSyncScheduler {
  start(): void
  stop(): void
  /** Request an immediate (coalesced) sync — used for the manual/forced path. */
  triggerNow(): void
}

export function createAutoSyncScheduler(deps: AutoSyncSchedulerDeps): AutoSyncScheduler {
  const clock = deps.clock ?? realClock
  const triggerEventTypes = deps.triggerEventTypes ?? AUTO_SYNC_TRIGGER_EVENT_TYPES
  const pullIntervalMs = deps.pullIntervalMs ?? DEFAULT_PULL_INTERVAL_MS
  const pushDebounceMs = deps.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS
  const startupDelayMs = deps.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS

  let started = false
  let unsubscribe: (() => void) | null = null
  let intervalHandle: unknown = null
  let startupHandle: unknown = null
  let debounceHandle: unknown = null

  // Single-flight: `running` guards the in-flight sync, `pending` records that
  // another run was requested while one was active.
  let running = false
  let pending = false

  async function drain(): Promise<void> {
    if (running) return
    running = true
    try {
      while (pending) {
        pending = false
        try {
          await deps.runSync()
        } catch (error) {
          deps.onError?.(error)
        }
      }
    } finally {
      running = false
    }
  }

  function requestSync(): void {
    pending = true
    void drain()
  }

  function scheduleDebouncedSync(): void {
    if (debounceHandle !== null) clock.clearTimeout(debounceHandle)
    debounceHandle = clock.setTimeout(() => {
      debounceHandle = null
      requestSync()
    }, pushDebounceMs)
  }

  return {
    start(): void {
      if (started) return
      started = true

      unsubscribe = deps.subscribe((event) => {
        if (triggerEventTypes.has(event.type)) scheduleDebouncedSync()
      })

      intervalHandle = clock.setInterval(() => requestSync(), pullIntervalMs)

      startupHandle = clock.setTimeout(() => {
        startupHandle = null
        requestSync()
      }, startupDelayMs)
    },

    stop(): void {
      if (!started) return
      started = false

      unsubscribe?.()
      unsubscribe = null

      if (intervalHandle !== null) {
        clock.clearInterval(intervalHandle)
        intervalHandle = null
      }
      if (startupHandle !== null) {
        clock.clearTimeout(startupHandle)
        startupHandle = null
      }
      if (debounceHandle !== null) {
        clock.clearTimeout(debounceHandle)
        debounceHandle = null
      }
      // Drop any queued follow-up so an in-flight sync doesn't loop after stop.
      pending = false
    },

    triggerNow(): void {
      requestSync()
    }
  }
}
