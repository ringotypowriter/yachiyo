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

export interface ThreadOpenRead {
  includeMessages: boolean
  limit?: number
}

/**
 * Decide how much of a thread to read when it is opened.
 *
 * Three cases, and the third is the one paging introduced. Opening a thread
 * normally reads its newest page. Re-opening a loaded thread reads no messages
 * at all. But a jump to a specific message — a search result, a Thing source —
 * names a message that may sit far above the newest page, and before paging
 * that state could not happen: everything was loaded, so the target was always
 * there. A page-sized read would land on the newest messages and the jump
 * would quietly do nothing.
 *
 * Those jumps are rare, so an unpaged read is the cheap answer.
 */
export function resolveThreadOpenRead(input: {
  loadedMessages: Message[] | undefined
  scrollToMessageId?: string | null
}): ThreadOpenRead {
  const loaded = input.loadedMessages
  const target = input.scrollToMessageId
  if (target && !loaded?.some((message) => message.id === target)) {
    return { includeMessages: true }
  }
  if (!loaded?.length) {
    return { includeMessages: true, limit: THREAD_MESSAGE_PAGE_SIZE }
  }
  return { includeMessages: false }
}
