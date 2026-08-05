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
}): Promise<void> {
  const claim = await claimQuietly(input)

  const body = claim ? `${claim.message}\n\n${input.text}` : input.text

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

async function claimQuietly(input: {
  channelId: string | undefined
  lease?: UpdateReceiptLease
  onError?: (stage: string, error: unknown) => void
}): Promise<{ claimToken: string; message: string } | undefined> {
  if (!input.lease || input.channelId === undefined) return undefined
  try {
    return await input.lease.claim(input.channelId)
  } catch (error) {
    input.onError?.('claim', error)
    return undefined
  }
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
