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
export type ThreadMessageAuthority = Record<string, number>

export function bumpThreadMessageAuthority(
  current: ThreadMessageAuthority,
  threadId: string
): ThreadMessageAuthority {
  return { ...current, [threadId]: (current[threadId] ?? 0) + 1 }
}

export function isThreadMessageReadStale(input: {
  captured: number | undefined
  current: number | undefined
}): boolean {
  return (input.captured ?? 0) !== (input.current ?? 0)
}
