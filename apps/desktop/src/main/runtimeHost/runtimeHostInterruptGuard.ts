interface RuntimeHostSignalTarget {
  on(event: 'SIGINT', listener: () => void): unknown
  off(event: 'SIGINT', listener: () => void): unknown
}

/**
 * Main owns graceful app shutdown and asks the utility runtime to flush over RPC.
 * A terminal interrupt reaches both processes at once, so consuming it here keeps
 * the runtime alive until main completes that shutdown handshake.
 */
export function installRuntimeHostInterruptGuard(target: RuntimeHostSignalTarget): () => void {
  const onInterrupt = (): void => {}
  target.on('SIGINT', onInterrupt)
  return () => target.off('SIGINT', onInterrupt)
}
