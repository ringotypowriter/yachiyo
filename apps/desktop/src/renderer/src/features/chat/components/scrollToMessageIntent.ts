/**
 * What to do with a pending "jump to this message" intent on one render.
 *
 * A thread's timeline holds only the pages read so far, so a jump target can
 * legitimately be absent right now and present two pages later. Consuming the
 * intent on absence is what makes such a jump vanish with no way back.
 */
export type ScrollToMessageIntentOutcome =
  | 'scroll'
  /** Target is not loaded yet, but older messages can still arrive. */
  | 'load-older'
  /** The whole thread is loaded and the target is not in it. */
  | 'abandon'

export function resolveScrollToMessageIntent(input: {
  targetIndex: number
  hasOlderMessages: boolean
}): ScrollToMessageIntentOutcome {
  if (input.targetIndex >= 0) return 'scroll'
  return input.hasOlderMessages ? 'load-older' : 'abandon'
}

/** The intent survives only while older pages could still satisfy it. */
export function shouldKeepScrollToMessageIntent(outcome: ScrollToMessageIntentOutcome): boolean {
  return outcome === 'load-older'
}
