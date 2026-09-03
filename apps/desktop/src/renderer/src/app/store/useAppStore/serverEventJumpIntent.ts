/**
 * A pending "jump to this message" intent belongs to the thread it was set
 * for. `setActiveThread` and `setActiveArchivedThread` retire it on every
 * switch, but server events switch threads themselves — deleting, archiving,
 * or restoring moves the user without going through those actions.
 *
 * Both views own the same single intent, so either one moving retires it.
 * Comparing only the live thread misses the archived view, where deleting the
 * open item switches `activeArchivedThreadId` and leaves `activeThreadId`
 * untouched.
 */
const THREAD_SELECTION_KEYS = ['activeThreadId', 'activeArchivedThreadId'] as const

export interface JumpIntentSelection {
  activeThreadId: string | null
  activeArchivedThreadId: string | null
  scrollToMessageId: string | null
}

export function retireJumpIntentOnThreadSwitch<State extends JumpIntentSelection>(
  previous: State,
  next: Partial<State>
): Partial<State> {
  const switched = THREAD_SELECTION_KEYS.some(
    (key) => next[key] !== undefined && next[key] !== previous[key]
  )
  if (!switched) return next
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
