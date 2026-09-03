/**
 * A pending "jump to this message" intent names the thread it belongs to, so
 * it can only ever fire in that conversation. What it still needs is retiring
 * when that conversation stops being open: server events switch threads
 * themselves — deleting, archiving, or restoring moves the user without going
 * through setActiveThread, which is what normally retires it.
 */
export interface JumpIntentSelection {
  activeThreadId: string | null
  activeArchivedThreadId: string | null
  scrollToMessage: { threadId: string; messageId: string } | null
}

export function retireJumpIntentOnThreadSwitch<State extends JumpIntentSelection>(
  previous: State,
  next: Partial<State>
): Partial<State> {
  const intent =
    next.scrollToMessage === undefined ? previous.scrollToMessage : next.scrollToMessage
  if (!intent) return next

  const activeThreadId =
    next.activeThreadId === undefined ? previous.activeThreadId : next.activeThreadId
  const activeArchivedThreadId =
    next.activeArchivedThreadId === undefined
      ? previous.activeArchivedThreadId
      : next.activeArchivedThreadId

  // Its own thread is still open in one of the two views, so the jump is still
  // reachable. A change to the *other* view is none of its business — that is
  // what made a bare message id ambiguous.
  if (intent.threadId === activeThreadId || intent.threadId === activeArchivedThreadId) {
    return next
  }
  return { ...next, scrollToMessage: null }
}
