/**
 * Per-thread revision of the authoritative message state.
 *
 * A thread's messages have two writers: on-demand reads issued by the UI, and
 * sync events that push the server's whole snapshot. The reads are older by the
 * time they resolve, so without a barrier a page that was requested before a
 * snapshot arrived would overwrite it — silently cutting a synced history back
 * to one page.
 *
 * Every writer of authoritative state bumps the thread's revision; every read
 * captures it before dispatching and discards its own payload if it changed.
 */
export interface ThreadMessageAuthorityEntry {
  revision: number
  /**
   * The thread no longer exists. A stale read of a replaced thread may still
   * refresh state the replacement did not carry; a stale read of a deleted one
   * must write nothing at all, or it repopulates caches of a gone thread.
   */
  deleted: boolean
}

export type ThreadMessageAuthority = Record<string, ThreadMessageAuthorityEntry>

export function bumpThreadMessageAuthority(
  current: ThreadMessageAuthority,
  threadId: string,
  options: { deleted?: boolean } = {}
): ThreadMessageAuthority {
  return {
    ...current,
    [threadId]: {
      revision: (current[threadId]?.revision ?? 0) + 1,
      deleted: options.deleted ?? false
    }
  }
}

export function isThreadMessageReadStale(input: {
  captured: ThreadMessageAuthorityEntry | undefined
  current: ThreadMessageAuthorityEntry | undefined
}): boolean {
  return (input.captured?.revision ?? 0) !== (input.current?.revision ?? 0)
}

/** True when the thread this read described has since been deleted. */
export function isThreadDeleted(current: ThreadMessageAuthorityEntry | undefined): boolean {
  return current?.deleted === true
}
