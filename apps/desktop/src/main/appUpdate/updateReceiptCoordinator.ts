import type { ReadPendingUpdateReceipt } from './pendingUpdateReceipt.ts'

export interface UpdateReceiptClaim {
  claimToken: string
  message: string
}

export interface UpdateReceiptCoordinatorDeps {
  /** The pending record, or undefined when there is nothing owed. */
  read: () => ReadPendingUpdateReceipt | undefined
  /** Clears the record, but only for the attempt that owns it. */
  clear: (attemptId: string) => void
  /** Renders the record into the sentence the user will read. */
  describe: (receipt: ReadPendingUpdateReceipt) => string
  newToken: () => string
}

/**
 * Owns the fate of a pending receipt that could not be delivered actively.
 *
 * The record stays a main-process file with a single owner. The runtime never
 * keeps its own copy — it asks to carry the message on its next real outbound
 * and reports back whether that succeeded. Two processes writing one record is
 * how a receipt ends up delivered twice or lost entirely, so the second
 * process gets a lease, not a copy.
 *
 * Deliberately at-least-once. Sending to QQ and acknowledging locally cannot
 * be one atomic act, so a crash between them repeats a receipt. Repeating is
 * the honest failure here: clearing before the send would silently lose it,
 * and losing it is the thing this layer exists to prevent.
 */
export function createUpdateReceiptCoordinator(deps: UpdateReceiptCoordinatorDeps): {
  defer: (attemptId: string) => void
  canActivelyDeliver: (attemptId: string) => boolean
  claim: (channelId: string) => UpdateReceiptClaim | undefined
  ack: (claimToken: string) => void
  release: (claimToken: string) => void
  releaseAllClaims: () => void
} {
  /** Set once an active send has failed and the receipt is owed to a later message. */
  let deferredAttemptId: string | undefined
  let liveClaim: { token: string; attemptId: string } | undefined

  return {
    defer(attemptId) {
      deferredAttemptId = attemptId
    },

    canActivelyDeliver(attemptId) {
      return deferredAttemptId !== attemptId
    },

    claim(channelId) {
      // Not deferred yet means the active send is still the owner of this
      // receipt. Handing it out now would let both paths deliver it.
      if (!deferredAttemptId) return undefined
      // One lease at a time: concurrent outbounds must not each carry it.
      if (liveClaim) return undefined

      const receipt = deps.read()
      if (!receipt) return undefined
      if (receipt.channelId !== channelId) return undefined
      if (receipt.attemptId !== deferredAttemptId) return undefined

      const claimToken = deps.newToken()
      liveClaim = { token: claimToken, attemptId: receipt.attemptId }
      return { claimToken, message: deps.describe(receipt) }
    },

    ack(claimToken) {
      if (liveClaim?.token !== claimToken) return
      deps.clear(liveClaim.attemptId)
      liveClaim = undefined
      deferredAttemptId = undefined
    },

    release(claimToken) {
      if (liveClaim?.token !== claimToken) return
      // The record survives: the send failed, so somebody is still owed it.
      liveClaim = undefined
    },

    releaseAllClaims() {
      // The runtime died holding a lease. Without this the receipt would stay
      // locked until the app restarted — indefinitely undeliverable while
      // looking like it was in progress.
      liveClaim = undefined
    }
  }
}
