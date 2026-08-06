import type { ManagedChannelService } from './channelServiceLifecycle.ts'
import { sleep } from './connectionRetry.ts'

export async function waitForManagedChannelServiceReady(input: {
  getService: () => ManagedChannelService | null
  retryDelayMs?: number
  signal?: AbortSignal
  onHealthCheckError?: (error: unknown) => void
}): Promise<void> {
  const retryDelayMs = input.retryDelayMs ?? 1_000

  while (true) {
    input.signal?.throwIfAborted()
    const service = input.getService()
    if (service) {
      let healthy = false
      try {
        healthy = await service.healthCheck()
      } catch (error) {
        input.onHealthCheckError?.(error)
      }
      input.signal?.throwIfAborted()
      if (healthy) return
    }
    await sleep(retryDelayMs, input.signal)
  }
}
