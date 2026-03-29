/**
 * Probabilistic speech throttle for group chat.
 *
 * Tracks how frequently the bot has spoken in a sliding window.
 * The more it speaks, the higher the chance the next message gets
 * silently dropped. Silence lets the probability recover to 100%.
 *
 * Window: 10 minutes. Drop curve:
 *   0-1 recent replies → 0% drop (always send)
 *   2 recent replies   → 30% drop
 *   3 recent replies   → 60% drop
 *   4+ recent replies  → 85% drop
 */

const THROTTLE_WINDOW_MS = 5 * 60 * 1_000

const DROP_CURVE: number[] = [
  0, // 0 recent replies
  0, // 1
  0, // 2
  0.1, // 3
  0.2, // 4
  0.35, // 5
  0.5, // 6
  0.65, // 7
  0.8 // 8+
]

function dropProbability(recentCount: number): number {
  return DROP_CURVE[Math.min(recentCount, DROP_CURVE.length - 1)]
}

export interface SpeechThrottle {
  /** Returns true if the message should be dropped (silenced). */
  shouldDrop(groupId: string): boolean
  /** Record that a message was actually sent. */
  recordSend(groupId: string): void
  /** Current drop probability for a group (0–1). For logging. */
  getDropRate(groupId: string): number
}

export function createSpeechThrottle(): SpeechThrottle {
  const replyTimestamps = new Map<string, number[]>()

  function prune(groupId: string): number[] {
    const timestamps = replyTimestamps.get(groupId)
    if (!timestamps) return []

    const cutoff = Date.now() - THROTTLE_WINDOW_MS
    const pruned = timestamps.filter((t) => t > cutoff)
    replyTimestamps.set(groupId, pruned)
    return pruned
  }

  return {
    shouldDrop(groupId) {
      const recent = prune(groupId)
      const prob = dropProbability(recent.length)
      if (prob <= 0) return false
      if (prob >= 1) return true
      return Math.random() < prob
    },

    recordSend(groupId) {
      const timestamps = replyTimestamps.get(groupId) ?? []
      timestamps.push(Date.now())
      replyTimestamps.set(groupId, timestamps)
    },

    getDropRate(groupId) {
      const recent = prune(groupId)
      return dropProbability(recent.length)
    }
  }
}
