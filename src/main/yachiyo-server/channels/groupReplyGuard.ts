const LEADING_COLON_PREFIX_RE = /^\s*[:：]+\s*/
const INTERNAL_WHITESPACE_RE = /\s+/g
const DEFAULT_GROUP_REPLY_HISTORY_MAX_ENTRIES = 10

export interface GroupReplyHistory {
  texts: string[]
  timestamps: number[]
}

export const GROUP_REPLY_DEDUP_WINDOW_MS = 30 * 60 * 1_000

function pruneExpiredGroupReplyHistory(history: GroupReplyHistory, nowMs: number): void {
  while (
    history.timestamps.length > 0 &&
    nowMs - history.timestamps[0] > GROUP_REPLY_DEDUP_WINDOW_MS
  ) {
    history.timestamps.shift()
    history.texts.shift()
  }
}

export function hasForbiddenGroupReplyPrefix(message: string): boolean {
  return /^\s*[:：]/.test(message)
}

export function normalizeGroupReplyForComparison(message: string): string {
  return message
    .trim()
    .replace(LEADING_COLON_PREFIX_RE, '')
    .trim()
    .replace(INTERNAL_WHITESPACE_RE, ' ')
    .toLowerCase()
}

export function isNearDuplicateGroupReply(candidate: string, previous: string): boolean {
  const normalizedCandidate = normalizeGroupReplyForComparison(candidate)
  const normalizedPrevious = normalizeGroupReplyForComparison(previous)

  if (!normalizedCandidate || !normalizedPrevious) {
    return false
  }

  return normalizedCandidate === normalizedPrevious
}

export function shouldSuppressGroupReply(
  history: GroupReplyHistory | undefined,
  message: string,
  nowMs = Date.now()
): boolean {
  const normalizedMessage = normalizeGroupReplyForComparison(message)
  if (!normalizedMessage || !history) {
    return false
  }

  pruneExpiredGroupReplyHistory(history, nowMs)
  return history.texts.some((text) => text === normalizedMessage)
}

export function appendGroupReplyHistory(
  history: GroupReplyHistory | undefined,
  message: string,
  sentAtMs = Date.now(),
  maxEntries = DEFAULT_GROUP_REPLY_HISTORY_MAX_ENTRIES
): GroupReplyHistory {
  const normalizedMessage = normalizeGroupReplyForComparison(message)
  const nextHistory = history ?? { texts: [], timestamps: [] }

  if (!normalizedMessage) {
    return nextHistory
  }

  nextHistory.texts.push(normalizedMessage)
  nextHistory.timestamps.push(sentAtMs)

  while (nextHistory.texts.length > maxEntries) {
    nextHistory.texts.shift()
    nextHistory.timestamps.shift()
  }

  return nextHistory
}
