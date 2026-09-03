import type { Message } from '../../types.ts'

/**
 * How many messages a thread hands back per page.
 *
 * Large enough that most conversations arrive whole on the first read, small
 * enough that a very long one opens without waiting for all of it.
 */
export const THREAD_MESSAGE_PAGE_SIZE = 60

/**
 * Whether a thread probably has messages above the page just loaded.
 *
 * A full page means the read stopped at the limit rather than at the top, so
 * there is more to fetch. A short page means the top was reached — asking
 * again would return nothing and the UI would keep offering to load.
 */
export function hasOlderThreadMessages(pageLength: number): boolean {
  return pageLength >= THREAD_MESSAGE_PAGE_SIZE
}

/**
 * Put an older page ahead of what is already loaded.
 *
 * Ids already present are dropped: the live event stream can deliver a message
 * that the older page also contains, and showing it twice reads as if it was
 * said twice. Returns the original array when there is nothing to add, so the
 * timeline can skip a re-render — a re-render there re-runs the scroll-anchor
 * correction for no reason.
 */
export function prependOlderThreadMessages(loaded: Message[], older: Message[]): Message[] {
  if (older.length === 0) return loaded
  const loadedIds = new Set(loaded.map((message) => message.id))
  const additions = older.filter((message) => !loadedIds.has(message.id))
  if (additions.length === 0) return loaded
  return [...additions, ...loaded]
}
