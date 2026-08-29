export interface PendingUpdateReceiptDeliveryLifecycle {
  requestDelivery(): Promise<void>
}

/**
 * Serializes startup receipt delivery across runtime generations.
 *
 * A utility runtime can exit while its readiness RPC is pending. The replacement
 * requests another pass, but that pass must wait for the old RPC to reject so
 * the two generations cannot actively deliver the same receipt concurrently.
 * Repeated lifecycle signals coalesce into one queued pass.
 */
export function createPendingUpdateReceiptDeliveryLifecycle(input: {
  deliver: () => Promise<void>
  onDeliveryError: (error: unknown) => void
}): PendingUpdateReceiptDeliveryLifecycle {
  let delivery: Promise<void> | null = null
  let deliveryRequested = false

  return {
    requestDelivery(): Promise<void> {
      deliveryRequested = true
      if (!delivery) {
        delivery = (async () => {
          while (deliveryRequested) {
            deliveryRequested = false
            try {
              await input.deliver()
            } catch (error) {
              input.onDeliveryError(error)
            }
          }
        })().finally(() => {
          delivery = null
        })
      }
      return delivery
    }
  }
}
