import type { ReadPendingUpdateReceipt } from './pendingUpdateReceipt.ts'

export async function deliverPendingUpdateReceiptAfterChannelReady(input: {
  read: () => ReadPendingUpdateReceipt | undefined
  waitForChannelReady: (channelId: string) => Promise<void>
  describe: (receipt: ReadPendingUpdateReceipt) => string
  sendActive: (input: { channelId: string; message: string; notAfterMs: number }) => Promise<void>
  sendTimeoutMs: number
  now?: () => number
  clear: (attemptId: string) => void
  defer: (attemptId: string) => void
  onDeliveryError?: (error: unknown) => void
}): Promise<void> {
  const pending = input.read()
  if (!pending) return

  await input.waitForChannelReady(pending.channelId)

  // A health wait may last through reconnect backoff. Never send a stale
  // record if another install replaced this one in the meantime.
  const readyPending = input.read()
  if (readyPending?.attemptId !== pending.attemptId) return

  const notAfterMs = (input.now ?? Date.now)() + input.sendTimeoutMs
  try {
    await withinSendBound(
      input.sendActive({
        channelId: readyPending.channelId,
        message: input.describe(readyPending),
        notAfterMs
      }),
      input.sendTimeoutMs
    )
    input.clear(readyPending.attemptId)
  } catch (error) {
    input.onDeliveryError?.(error)
    input.defer(readyPending.attemptId)
  }
}

async function withinSendBound<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle!: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Active update receipt delivery timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  })

  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timeoutHandle)
  }
}
