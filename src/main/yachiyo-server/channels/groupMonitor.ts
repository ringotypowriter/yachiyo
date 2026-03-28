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

import type { GroupMessageEntry, GroupReplyDecision } from '../../../shared/yachiyo/protocol.ts'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GroupMonitorConfig {
  /** Check interval while active (default 30 000 ms). */
  activeCheckIntervalMs: number
  /** Check interval while engaged (default 10 000 ms). */
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
  /** Called each check interval with unprocessed messages. Return a reply decision. */
  onCheck(recentMessages: GroupMessageEntry[]): Promise<GroupReplyDecision>
  /** Called when the judge says "reply". Receives the full buffer for context. */
  onReply(decision: GroupReplyDecision, allRecentMessages: GroupMessageEntry[]): Promise<void>
  /** Notifies the owner whenever the phase changes. */
  onStateChange(newPhase: Phase): void
}

export type Phase = 'dormant' | 'active' | 'engaged'

export interface GroupMonitor {
  /** Feed an inbound group message into the buffer. */
  onMessage(entry: GroupMessageEntry): void
  /** Current state-machine phase. */
  getPhase(): Phase
  /** All buffered recent messages (read-only snapshot). */
  getRecentMessages(): GroupMessageEntry[]
  /** Tear down all timers. */
  stop(): void
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const GROUP_MONITOR_DEFAULTS: GroupMonitorConfig = {
  activeCheckIntervalMs: 30_000,
  engagedCheckIntervalMs: 10_000,
  wakeBufferMs: 30_000,
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
  callbacks: GroupMonitorCallbacks
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

  // -------------------------------------------------------------------------
  // Buffer helpers
  // -------------------------------------------------------------------------

  function pruneBuffer(): void {
    const cutoff = Date.now() / 1_000 - config.recentMessageWindowMs / 1_000
    while (buffer.length > 0 && buffer[0].timestamp < cutoff) {
      buffer.shift()
      cursor = Math.max(0, cursor - 1)
    }
    while (buffer.length > config.maxRecentMessages) {
      buffer.shift()
      cursor = Math.max(0, cursor - 1)
    }
  }

  function newMessagesSinceLastCheck(): GroupMessageEntry[] {
    return buffer.slice(cursor)
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

      // Ask the judge.
      const decision = await callbacks.onCheck(fresh)

      if (decision.shouldReply) {
        await callbacks.onReply(decision, [...buffer])
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

    // @mention → skip any wake buffer and trigger an immediate check.
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
    buffer.length = 0
  }

  return {
    onMessage,
    getPhase: () => phase,
    getRecentMessages: () => [...buffer],
    stop
  }
}
