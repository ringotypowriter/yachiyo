/**
 * A pending "jump to this message" intent names the thread it belongs to, so
 * it can only ever fire in that conversation. What it still needs is retiring
 * when that conversation leaves the screen: server events switch threads
 * themselves — deleting, archiving, or restoring moves the user without going
 * through setActiveThread or setActiveArchivedThread, which are what normally
 * retire it.
 */
export interface JumpIntentSelection {
  threadListMode: 'active' | 'archived'
  activeThreadId: string | null
  activeArchivedThreadId: string | null
  scrollToMessage: { threadId: string; messageId: string } | null
}

function resolve<State extends JumpIntentSelection, Key extends keyof State>(
  previous: State,
  next: Partial<State>,
  key: Key
): State[Key] {
  return next[key] === undefined ? previous[key] : (next[key] as State[Key])
}

export function retireJumpIntentOnThreadSwitch<State extends JumpIntentSelection>(
  previous: State,
  next: Partial<State>
): Partial<State> {
  const intent = resolve(previous, next, 'scrollToMessage')
  if (!intent) return next

  // Only one list is on screen, and only its selection can show the jump. The
  // other one holding the same thread is not enough: archiving the open thread
  // selects it in the archived list while leaving the reader in the live one,
  // where the intent would linger with nothing to consume it.
  const visibleThreadId =
    resolve(previous, next, 'threadListMode') === 'archived'
      ? resolve(previous, next, 'activeArchivedThreadId')
      : resolve(previous, next, 'activeThreadId')

  if (intent.threadId === visibleThreadId) return next
  return { ...next, scrollToMessage: null }
}
