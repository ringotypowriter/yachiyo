import type { PendingUpdateReceipt } from './pendingUpdateReceipt.ts'

export interface UpdateReceiptOrigin {
  channelId: string
  threadId: string
  messageId: string
}

/**
 * Distinguishes "this run has nobody waiting" from "we could not find out".
 *
 * Collapsing those into `undefined` is what let a completely unreachable
 * lookup masquerade as a local thread: the receipt was skipped, the install
 * proceeded, and nothing anywhere said the feature had failed.
 */
export type OriginLookup =
  | { kind: 'origin'; origin: UpdateReceiptOrigin }
  | { kind: 'no-channel' }
  | { kind: 'lookup-failed'; reason: string }

export interface InstallReceiptDeps {
  resolveOrigin: (runId: string) => Promise<OriginLookup>
  persist: (receipt: PendingUpdateReceipt) => void
  clear: (attemptId: string) => void
  /** Claims the install slot. Throws if it cannot be claimed. */
  reserve: () => void
  /**
   * Signalled once the bounded wait has elapsed. The send is abandoned at that
   * point, so an implementation that has not yet dispatched must not dispatch:
   * a "back shortly" arriving after we gave up is a promise for an install
   * that may never have started.
   */
  announce: (origin: UpdateReceiptOrigin, signal: AbortSignal) => Promise<void>
  announceTimeoutMs: number
  now: () => number
  /** Identifies this attempt so a losing contender cannot clear our record. */
  attemptId: string
  fromVersion: string
  targetVersion: string
}

/** Resolves either way — the caller decides what a timeout means. */
function withinBound<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))
  ])
}

/**
 * The order in which an update announces itself, and what happens when each
 * step fails.
 *
 * The sequence is the contract, so it lives in one testable function rather
 * than as statements interleaved through the socket handler:
 *
 *   resolve → persist → reserve → announce → (caller replies, then quits)
 *
 * Persist comes before reserve because the record is the only thing that
 * survives the restart; reserve comes before announce because promising to
 * come back before knowing the install can start is the same lie this layer
 * was built to stop telling.
 */
export async function runInstallReceiptSequence(
  initiatorRunId: string | undefined,
  deps: InstallReceiptDeps
): Promise<void> {
  if (initiatorRunId === undefined) {
    deps.reserve()
    return
  }

  const lookup = await deps.resolveOrigin(initiatorRunId)

  if (lookup.kind === 'lookup-failed') {
    // We know someone *might* be waiting and we cannot find out who. Installing
    // anyway would restart into silence; refusing is recoverable and says why.
    throw new Error(`Cannot determine where to report this update back to: ${lookup.reason}`)
  }

  if (lookup.kind === 'no-channel') {
    // Genuinely nobody waiting in a chat for this one.
    deps.reserve()
    return
  }

  const origin = lookup.origin

  // Throwing here aborts before anything irreversible: an update we cannot
  // report on afterwards is worse than an update that didn't happen, because
  // the user is left waiting either way and only one of them is recoverable.
  deps.persist({
    attemptId: deps.attemptId,
    channelId: origin.channelId,
    threadId: origin.threadId,
    messageId: origin.messageId,
    fromVersion: deps.fromVersion,
    targetVersion: deps.targetVersion,
    startedAtMs: deps.now()
  })

  try {
    deps.reserve()
  } catch (error) {
    // The record describes an install that will not happen; leaving it would
    // make the next start report a phantom update.
    deps.clear(deps.attemptId)
    throw error
  }

  // Best-effort and time-boxed. A send that fails or hangs costs the user the
  // opening sentence, not the update — and the post-restart receipt still
  // closes the loop. Blocking here would hold the install window open for as
  // long as the network felt like it.
  const abandon = new AbortController()
  try {
    await withinBound(deps.announce(origin, abandon.signal), deps.announceTimeoutMs)
  } catch {
    // Deliberately swallowed: see above.
  } finally {
    // Whether it timed out or threw, we are no longer waiting on it — say so,
    // so a send that has not left yet stays unsent rather than surfacing later.
    abandon.abort()
  }
}
