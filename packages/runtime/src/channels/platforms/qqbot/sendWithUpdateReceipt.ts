export interface UpdateReceiptLease {
  claim: (channelId: string) => Promise<{ claimToken: string; message: string } | undefined>
  ack: (claimToken: string) => Promise<void>
  release: (claimToken: string) => Promise<void>
}

/**
 * Send one message, carrying an owed update receipt if one is waiting.
 *
 * Claimed at the moment of a *real* outbound rather than when the user's
 * message arrived: a turn may produce text, an error reply, or only
 * attachments, and the receipt should ride whatever actually leaves first.
 * Acked the instant that send succeeds, so a later attachment failure cannot
 * cause the receipt to go out twice.
 *
 * Every lease call is guarded. The receipt is a courtesy; the reply the user
 * is waiting for is not, and must never fail because the bookkeeping did.
 */
export async function sendWithUpdateReceipt(input: {
  channelId: string | undefined
  text: string
  send: (body: string) => Promise<void>
  lease?: UpdateReceiptLease
  onError?: (stage: string, error: unknown) => void
  /** Ceiling on every lease round trip. The reply must never wait on it. */
  leaseTimeoutMs?: number
}): Promise<void> {
  const claim = await claimQuietly(input)

  if (!claim && !input.text) return

  const body = claim
    ? input.text
      ? `${claim.message}\n\n${input.text}`
      : claim.message
    : input.text

  try {
    await input.send(body)
  } catch (error) {
    // The receipt never reached anyone, so it is still owed. Returning the
    // lease leaves it for the next outbound instead of losing it here.
    if (claim) await guard(input, 'release', () => input.lease!.release(claim.claimToken))
    throw error
  }

  if (claim) await guard(input, 'ack', () => input.lease!.ack(claim.claimToken))
}

const DEFAULT_LEASE_TIMEOUT_MS = 2_000

/**
 * A lease call that never settles must not hold the reply hostage.
 *
 * Guarding only against rejection left the worst case open: a reverse RPC
 * that hangs would block the user's answer indefinitely. Bounded, and a claim
 * that arrives after the bound is released rather than dropped — otherwise
 * the receipt would stay leased to a send that already went out without it.
 */
async function claimQuietly(input: {
  channelId: string | undefined
  lease?: UpdateReceiptLease
  onError?: (stage: string, error: unknown) => void
  leaseTimeoutMs?: number
}): Promise<{ claimToken: string; message: string } | undefined> {
  if (!input.lease || input.channelId === undefined) return undefined

  const lease = input.lease
  const timeoutMs = input.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS
  let settled = false

  const pending = lease.claim(input.channelId).then(
    (claim) => {
      if (settled && claim) {
        // Too late to use: give the lease back so the next outbound can.
        void lease.release(claim.claimToken).catch((error) => input.onError?.('release', error))
        return undefined
      }
      return claim
    },
    (error) => {
      if (!settled) input.onError?.('claim', error)
      return undefined
    }
  )

  // A distinct sentinel, because "the claim timed out" and "nothing is owed"
  // are different facts and only one of them is worth reporting.
  const TIMED_OUT = Symbol('lease-claim-timeout')
  const timeout = new Promise<typeof TIMED_OUT>((resolve) =>
    setTimeout(() => resolve(TIMED_OUT), timeoutMs)
  )

  const result = await Promise.race([pending, timeout])
  settled = true

  if (result === TIMED_OUT) {
    input.onError?.('claim-timeout', new Error('update receipt lease claim timed out'))
    return undefined
  }
  return result
}

async function guard(
  input: { onError?: (stage: string, error: unknown) => void },
  stage: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run()
  } catch (error) {
    input.onError?.(stage, error)
  }
}
