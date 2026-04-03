const LEADING_COLON_PREFIX_RE = /^\s*[:：]+\s*/
const INTERNAL_WHITESPACE_RE = /\s+/g

export const GROUP_REPLY_DEDUP_WINDOW_MS = 30 * 60 * 1_000

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
