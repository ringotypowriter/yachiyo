/**
 * What to do with a pending "jump to this message" intent on one render.
 *
 * A thread's timeline holds only the pages read so far, so a jump target can
 * legitimately be absent right now and present once the read already in flight
 * lands. Consuming the intent on absence is what makes such a jump vanish with
 * no way back.
 */
export type ScrollToMessageIntentOutcome =
  | 'scroll'
  /** Target is not loaded yet, but the thread has older messages to arrive. */
  | 'wait'
  /** The whole thread is loaded and the target is not in it. */
  | 'abandon'

export function resolveScrollToMessageIntent(input: {
  targetIndex: number
  hasOlderMessages: boolean
  /**
   * Whether this thread's messages have been read at all. An empty timeline
   * means two different things — the read has not landed yet, or the thread is
   * genuinely empty — and only the second one is grounds for giving up.
   */
  hasLoadedMessages: boolean
}): ScrollToMessageIntentOutcome {
  if (input.targetIndex >= 0) return 'scroll'
  if (!input.hasLoadedMessages) return 'wait'
  return input.hasOlderMessages ? 'wait' : 'abandon'
}

/** The intent survives only while messages that could satisfy it can still arrive. */
export function shouldKeepScrollToMessageIntent(outcome: ScrollToMessageIntentOutcome): boolean {
  return outcome === 'wait'
}
