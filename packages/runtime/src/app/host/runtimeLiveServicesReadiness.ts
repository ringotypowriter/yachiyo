export interface RuntimeLiveServicesReadiness {
  start(): Promise<void>
  waitForReady(): Promise<void>
}

export function createRuntimeLiveServicesReadiness(
  startOnce: () => Promise<void>
): RuntimeLiveServicesReadiness {
  let startup: Promise<void> | undefined
  const start = (): Promise<void> => {
    startup ??= startOnce()
    return startup
  }

  return { start, waitForReady: start }
}

export async function runAfterRuntimeLiveServicesReady(
  waitForReady: () => Promise<void>,
  run: () => Promise<void>
): Promise<void> {
  await waitForReady()
  await run()
}
