import type { MessageRecord } from '@yachiyo/shared/protocol'

/**
 * Order two strings the way sqlite's default BINARY collation does — by code
 * unit, not by locale.
 *
 * `localeCompare` disagrees with it on case: `'Message'.localeCompare('aessage')`
 * is positive, while sqlite puts `M` (0x4D) before `a` (0x61). A store that
 * orders in JavaScript has to compare the way sqlite will, or the two agree
 * only for as long as every id happens to be lowercase — which is true of
 * today's uuids and is not a property anything enforces.
 */
export function compareBinary(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

export interface MessagePageOptions {
  limit?: number
  beforeMessageId?: string
}

/**
 * The one place a page limit is judged legal, shared by every storage
 * implementation so they cannot drift into disagreeing about it.
 *
 * Zero is allowed and means an empty page — sqlite's `limit 0` says the same
 * thing, so both stores answer it identically without a special case. A
 * negative, fractional or infinite limit describes no page at all; refusing it
 * keeps the mistake at the caller instead of turning it into an empty
 * conversation the caller reads as "this thread is empty".
 */
export function assertPageLimit(limit: number | undefined): void {
  if (limit === undefined) return
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `A thread message page limit must be a non-negative integer, received ${limit}.`
    )
  }
}

/**
 * Select the page of a thread to hand back, walking backwards from the newest
 * message.
 *
 * Lives here rather than inside the sqlite reader because that file's tests
 * only run where the native module matches the host Node — which is to say,
 * almost never. Keeping the decision in plain code means it is actually
 * covered rather than merely accompanied by a test file.
 *
 * The window is anchored at the new end, but the page is returned in reading
 * order: callers render a conversation, not a reversed list.
 */
export function pageMessageWindow(
  messages: MessageRecord[],
  options?: MessagePageOptions
): MessageRecord[] {
  assertPageLimit(options?.limit)
  // A read that asked for no window gets the thread itself, uncopied.
  if (options?.limit === undefined && options?.beforeMessageId === undefined) return messages

  // Where the page ends. The cursor means "older than this message" whether or
  // not a limit came with it, so that the two options stay independent — the
  // sqlite reader applies them independently too.
  const end =
    options?.beforeMessageId === undefined
      ? messages.length
      : messages.findIndex((message) => message.id === options.beforeMessageId)
  // An unknown cursor must not fall back to "the newest page". That would
  // hand back the same messages every time while the caller believed it was
  // walking backwards — an infinite scroll that never moves.
  if (end < 0) return []

  const start = options?.limit === undefined ? 0 : Math.max(0, end - options.limit)
  return messages.slice(start, end)
}
