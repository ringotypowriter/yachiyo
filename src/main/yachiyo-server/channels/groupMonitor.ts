/**
 * Per-group state machine for the "lurk and engage" discussion mode.
 *
 * Phases:
 *   dormant  — no timer; wakes on first inbound message
 *   active   — 30 s check interval; goes dormant after N empty checks
 *   engaged  — 10 s check interval; reverts to active after N no-reply checks
 *
 * The monitor never calls the model directly — it delegates via callbacks.
 */

import type { GroupMessageEntry } from '../../../shared/yachiyo/protocol.ts'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GroupMonitorConfig {
  /** Check interval while active (default 60 000 ms). */
  activeCheckIntervalMs: number
  /** Check interval while engaged (default 30 000 ms). */
  engagedCheckIntervalMs: number
  /** Buffer time after wake before the first check (default 30 000 ms). */
  wakeBufferMs: number
  /** Consecutive empty checks before going dormant (default 3). */
  dormancyMissCount: number
  /** Consecutive no-reply checks (engaged) before reverting to active (default 3). */
  disengageMissCount: number
  /** Maximum entries kept in the recent-message ring buffer. */
  maxRecentMessages: number
  /** Maximum age (ms) for messages in the buffer. */
  recentMessageWindowMs: number
}

export interface GroupMonitorCallbacks {
  /**
   * Called each check interval with the full buffer.
   * The callback handles both decision and reply in a single pass.
   * Returns true if the model spoke, false if it stayed silent.
   */
  onTurn(recentMessages: GroupMessageEntry[]): Promise<boolean>
  /** Notifies the owner whenever the phase changes. */
  onStateChange(newPhase: Phase): void
}

export type Phase = 'dormant' | 'active' | 'engaged'

export interface GroupMonitorRestoreState {
  phase: Phase
  buffer: GroupMessageEntry[]
}

export interface GroupMonitor {
  /** Feed an inbound group message into the buffer. */
  onMessage(entry: GroupMessageEntry): void
  /** Current state-machine phase. */
  getPhase(): Phase
  /** All buffered recent messages (read-only snapshot). */
  getRecentMessages(): GroupMessageEntry[]
  /** Snapshot current state for persistence. */
  getSnapshot(): { phase: Phase; buffer: GroupMessageEntry[] }
  /** Tear down all timers. */
  stop(): void
  /** Wipe the in-memory message buffer without stopping the monitor. */
  clearBuffer(): void
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const GROUP_MONITOR_DEFAULTS: GroupMonitorConfig = {
  activeCheckIntervalMs: 60_000,
  engagedCheckIntervalMs: 30_000,
  wakeBufferMs: 60_000,
  dormancyMissCount: 3,
  disengageMissCount: 3,
  maxRecentMessages: 50,
  recentMessageWindowMs: 10 * 60 * 1_000
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGroupMonitor(
  config: GroupMonitorConfig,
  callbacks: GroupMonitorCallbacks,
  restoreState?: GroupMonitorRestoreState
): GroupMonitor {
  let phase: Phase = 'dormant'
  let missCount = 0
  let checkTimer: ReturnType<typeof setTimeout> | null = null
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let checking = false

  /** Ring buffer of recent messages. */
  const buffer: GroupMessageEntry[] = []

  /**
   * Cursor: index of the first message that has NOT yet been seen by a check.
   * Everything from `cursor` to `buffer.length` is "new since last check".
   */
  let cursor = 0

  /**
   * Number of messages in the buffer that came from a persisted restore.
   * While > 0, time-based eviction is skipped — restored messages survive
   * for cross-restart context continuity (the `<gap>` marker in the context
   * builder handles the time discontinuity). Count-based eviction still
   * applies, decrementing this counter as old messages get pushed out.
   * Once all restored messages are displaced by new ones, normal time-based
   * eviction resumes.
   */
  let restoredMessageCount = 0

  // Restore persisted buffer if provided. Starts dormant regardless of saved
  // phase — the monitor re-activates naturally on the next inbound message.
  if (restoreState && restoreState.buffer.length > 0) {
    buffer.push(...restoreState.buffer)
    // Only enforce count cap — no time-based eviction for restored messages.
    while (buffer.length > config.maxRecentMessages) {
      buffer.shift()
    }
    restoredMessageCount = buffer.length
    cursor = buffer.length
  }

  // -------------------------------------------------------------------------
  // Buffer helpers
  // -------------------------------------------------------------------------

  function pruneBuffer(): void {
    const cutoff = Date.now() / 1_000 - config.recentMessageWindowMs / 1_000
    // Time-based eviction: skip the protected restored block at the front,
    // but still evict aged-out new messages after it. Once all restored
    // messages are displaced by count, this becomes a normal front-eviction.
    while (
      buffer.length > restoredMessageCount &&
      buffer[restoredMessageCount].timestamp < cutoff
    ) {
      buffer.splice(restoredMessageCount, 1)
      if (cursor > restoredMessageCount) cursor--
    }
    // Count-based eviction from front (displaces oldest first, including restored).
    while (buffer.length > config.maxRecentMessages) {
      if (restoredMessageCount > 0) restoredMessageCount--
      buffer.shift()
      cursor = Math.max(0, cursor - 1)
    }
  }

  function newMessagesSinceLastCheck(): GroupMessageEntry[] {
    return buffer.slice(cursor).filter((m) => m.senderExternalUserId !== '__self__')
  }

  // -------------------------------------------------------------------------
  // Phase transitions
  // -------------------------------------------------------------------------

  function setPhase(next: Phase): void {
    if (next === phase) return
    phase = next
    missCount = 0
    callbacks.onStateChange(next)
  }

  function currentIntervalMs(): number {
    return phase === 'engaged' ? config.engagedCheckIntervalMs : config.activeCheckIntervalMs
  }

  // -------------------------------------------------------------------------
  // Timer management
  // -------------------------------------------------------------------------

  function clearTimers(): void {
    if (checkTimer) {
      clearInterval(checkTimer)
      checkTimer = null
    }
    if (wakeTimer) {
      clearTimeout(wakeTimer)
      wakeTimer = null
    }
  }

  function startCheckLoop(): void {
    if (checkTimer) clearInterval(checkTimer)
    checkTimer = setInterval(() => void runCheck(), currentIntervalMs())
  }

  // -------------------------------------------------------------------------
  // Core check
  // -------------------------------------------------------------------------

  async function runCheck(): Promise<void> {
    if (checking) return
    checking = true

    try {
      pruneBuffer()
      const fresh = newMessagesSinceLastCheck()

      // Advance cursor — these messages are now "seen".
      cursor = buffer.length

      if (phase === 'active' && fresh.length === 0) {
        missCount++
        if (missCount >= config.dormancyMissCount) {
          clearTimers()
          setPhase('dormant')
        }
        return
      }

      if (fresh.length === 0 && phase === 'engaged') {
        missCount++
        if (missCount >= config.disengageMissCount) {
          setPhase('active')
          startCheckLoop() // switch to slower interval
        }
        return
      }

      if (fresh.length === 0) return

      // Single pass: model decides + speaks (or stays silent) via onTurn.
      let replied: boolean
      try {
        replied = await callbacks.onTurn([...buffer])
      } catch (error) {
        // Connection or API failure — skip this turn without changing phase.
        // The monitor stays alive and will retry on the next check interval.
        console.error('[group-monitor] onTurn failed, skipping turn:', error)
        return
      }

      if (replied) {
        if (phase !== 'engaged') {
          setPhase('engaged')
          startCheckLoop() // switch to faster interval
        } else {
          missCount = 0 // reset on successful reply
        }
      } else if (phase === 'engaged') {
        missCount++
        if (missCount >= config.disengageMissCount) {
          setPhase('active')
          startCheckLoop()
        }
      }
    } finally {
      checking = false
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function onMessage(entry: GroupMessageEntry): void {
    buffer.push(entry)
    pruneBuffer()

    // @mention → fast-track to judge evaluation (judge can still say NO).
    if (entry.isMention) {
      if (wakeTimer) {
        clearTimeout(wakeTimer)
        wakeTimer = null
      }
      if (phase === 'dormant') {
        setPhase('active')
        startCheckLoop()
      }
      void runCheck()
      return
    }

    if (phase === 'dormant') {
      // Wake: start a buffer timer, then transition to active.
      if (!wakeTimer) {
        wakeTimer = setTimeout(() => {
          wakeTimer = null
          setPhase('active')
          void runCheck()
          startCheckLoop()
        }, config.wakeBufferMs)
      }
    }
  }

  function stop(): void {
    clearTimers()
    phase = 'dormant'
    missCount = 0
    cursor = 0
    restoredMessageCount = 0
    buffer.length = 0
  }

  function clearBuffer(): void {
    buffer.length = 0
    cursor = 0
    restoredMessageCount = 0
  }

  return {
    onMessage,
    getPhase: () => phase,
    getRecentMessages: () => [...buffer],
    getSnapshot: () => ({ phase, buffer: [...buffer] }),
    stop,
    clearBuffer
  }
}
