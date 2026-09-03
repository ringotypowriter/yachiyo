/**
 * A pending "jump to this message" intent belongs to the thread it was set
 * for. `setActiveThread` retires it on every switch, but server events switch
 * the active thread themselves — a thread being deleted, archived, or restored
 * moves the user without going through that action. Stated here once so it
 * holds for every such branch, including ones added later.
 */
export function retireJumpIntentOnThreadSwitch<
  State extends { activeThreadId: string | null; scrollToMessageId: string | null }
>(previous: State, next: Partial<State>): Partial<State> {
  if (next.activeThreadId === undefined || next.activeThreadId === previous.activeThreadId) {
    return next
  }
  // Most branches return the whole state, so the field being present says
  // nothing. Only a value the branch actually changed is its own jump target —
  // that one is about the thread being switched to, not the one being left.
  if (
    next.scrollToMessageId !== undefined &&
    next.scrollToMessageId !== previous.scrollToMessageId
  ) {
    return next
  }
  return { ...next, scrollToMessageId: null }
}
