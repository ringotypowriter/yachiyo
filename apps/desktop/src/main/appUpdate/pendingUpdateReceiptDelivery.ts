import type { ReadPendingUpdateReceipt } from './pendingUpdateReceipt.ts'

export async function deliverPendingUpdateReceiptAfterChannelReady(input: {
  read: () => ReadPendingUpdateReceipt | undefined
  waitForChannelReady: (channelId: string) => Promise<void>
  describe: (receipt: ReadPendingUpdateReceipt) => string
  sendActive: (input: { channelId: string; message: string }) => Promise<void>
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

  try {
    await input.sendActive({
      channelId: readyPending.channelId,
      message: input.describe(readyPending)
    })
    input.clear(readyPending.attemptId)
  } catch (error) {
    input.onDeliveryError?.(error)
    input.defer(readyPending.attemptId)
  }
}
