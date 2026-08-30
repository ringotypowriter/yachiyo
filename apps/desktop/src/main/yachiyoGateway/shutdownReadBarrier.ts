export interface ShutdownReadBarrier {
  run<TResult>(
    read: () => Promise<TResult>,
    stoppedValue: () => TResult | Promise<TResult>
  ): Promise<TResult>
  beginShutdown(): Promise<void>
}

export function createShutdownReadBarrier(): ShutdownReadBarrier {
  const inFlight = new Set<Promise<unknown>>()
  let shuttingDown = false

  return {
    async run<TResult>(
      read: () => Promise<TResult>,
      stoppedValue: () => TResult | Promise<TResult>
    ): Promise<TResult> {
      if (shuttingDown) return stoppedValue()

      const pending = read()
      inFlight.add(pending)
      try {
        return await pending
      } finally {
        inFlight.delete(pending)
      }
    },

    async beginShutdown(): Promise<void> {
      shuttingDown = true
      await Promise.allSettled([...inFlight])
    }
  }
}
