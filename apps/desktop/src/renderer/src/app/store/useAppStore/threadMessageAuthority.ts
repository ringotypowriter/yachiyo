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

export type ThreadReadOutcome =
  | 'apply'
  /** The thread was replaced; it still exists and can take what the replacement did not carry. */
  | 'stale'
  /** The thread is gone; this response must write nothing at all. */
  | 'deleted'

/**
 * Deletion is checked first and independently of the revision. A read issued
 * *after* the tombstone captures the same revision it later sees, so a
 * revision comparison alone reports it as current and lets it repopulate the
 * caches the delete cleared.
 */
/**
 * Whether the thread is gone, for callers that have no read to date-check —
 * a hydration keyed by thread id, or an attempt to open one.
 */
export function isThreadDeleted(current: ThreadMessageAuthorityEntry | undefined): boolean {
  return current?.deleted === true
}

export function resolveThreadReadOutcome(input: {
  captured: ThreadMessageAuthorityEntry | undefined
  current: ThreadMessageAuthorityEntry | undefined
}): ThreadReadOutcome {
  if (input.current?.deleted === true) return 'deleted'
  return (input.captured?.revision ?? 0) !== (input.current?.revision ?? 0) ? 'stale' : 'apply'
}

/**
 * Drop snapshots belonging to threads that have since been deleted.
 *
 * Applied to the response rather than at the call site on purpose: a listing
 * asked for one thread degrades to a listing of *all* threads whenever the
 * caller cannot name one, so a guard on the argument misses exactly the cases
 * where the response is widest.
 */
export function dropSnapshotsOfDeletedThreads<Snapshot extends { parentThreadId: string }>(
  snapshots: Snapshot[],
  authority: ThreadMessageAuthority
): Snapshot[] {
  return snapshots.filter((snapshot) => !isThreadDeleted(authority[snapshot.parentThreadId]))
}
