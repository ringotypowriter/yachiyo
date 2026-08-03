import type { PendingUpdateReceipt } from './pendingUpdateReceipt.ts'

export interface UpdateReceiptOrigin {
  channelId: string
  threadId: string
  messageId: string
}

export interface InstallReceiptDeps {
  /** `undefined` when the run has no external chat behind it. */
  resolveOrigin: (runId: string) => Promise<UpdateReceiptOrigin | undefined>
  persist: (receipt: PendingUpdateReceipt) => void
  clear: () => void
  /** Claims the install slot. Throws if it cannot be claimed. */
  reserve: () => void
  announce: (origin: UpdateReceiptOrigin) => Promise<void>
  announceTimeoutMs: number
  now: () => number
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

  const origin = await deps.resolveOrigin(initiatorRunId)
  if (!origin) {
    // Nobody is waiting in a chat for this one.
    deps.reserve()
    return
  }

  // Throwing here aborts before anything irreversible: an update we cannot
  // report on afterwards is worse than an update that didn't happen, because
  // the user is left waiting either way and only one of them is recoverable.
  deps.persist({
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
    deps.clear()
    throw error
  }

  // Best-effort and time-boxed. A send that fails or hangs costs the user the
  // opening sentence, not the update — and the post-restart receipt still
  // closes the loop. Blocking here would hold the install window open for as
  // long as the network felt like it.
  try {
    await withinBound(deps.announce(origin), deps.announceTimeoutMs)
  } catch {
    // Deliberately swallowed: see above.
  }
}
