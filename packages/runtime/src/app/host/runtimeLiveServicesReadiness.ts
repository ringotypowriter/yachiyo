export interface RuntimeLiveServicesReadiness {
  start(): Promise<void>
  waitForReady(): Promise<void>
  waitForChannelReady(channelId: string): Promise<void>
}

export function createRuntimeLiveServicesReadiness(
  startOnce: () => Promise<void>,
  waitForChannelReadyOnce: (channelId: string) => Promise<void>
): RuntimeLiveServicesReadiness {
  let startup: Promise<void> | undefined
  const start = (): Promise<void> => {
    startup ??= startOnce()
    return startup
  }

  return {
    start,
    waitForReady: start,
    async waitForChannelReady(channelId: string): Promise<void> {
      await start()
      await waitForChannelReadyOnce(channelId)
    }
  }
}

export async function runAfterRuntimeLiveServicesReady(
  waitForReady: () => Promise<void>,
  run: () => Promise<void>
): Promise<void> {
  await waitForReady()
  await run()
}
