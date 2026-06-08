/**
 * Shared one-shot connection retry with exponential backoff.
 *
 * `connectWithRetry` retries an initial connect call until it succeeds or is
 * aborted. It does not supervise a long-lived service after that first success;
 * channel recovery, health checks, and sleep-resume handling live in
 * channelServiceLifecycle.ts and the Electron gateway integration.
 */

export interface ConnectRetryOptions {
  /** Base delay in ms before the first retry (default 3 000). */
  baseDelayMs?: number
  /** Maximum delay cap in ms (default 30 000). */
  maxDelayMs?: number
  /** Maximum number of attempts — Infinity for unlimited (default Infinity). */
  maxAttempts?: number
  /** Label for log messages. */
  label?: string
  /** Called on each retry with the attempt number, scheduled delay, and the error. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void
  /** Abort signal — cancels the retry loop when aborted. */
  signal?: AbortSignal
}

/**
 * Call `connectFn` and retry on failure with exponential backoff.
 *
 * Resolves as soon as `connectFn` succeeds. Rejects when `maxAttempts` is
 * exhausted or when `signal` is aborted.
 */
export async function connectWithRetry(
  connectFn: () => Promise<void>,
  options?: ConnectRetryOptions
): Promise<void> {
  const baseDelay = options?.baseDelayMs ?? 3_000
  const maxDelay = options?.maxDelayMs ?? 30_000
  const maxAttempts = options?.maxAttempts ?? Infinity
  const label = options?.label ?? 'connection'

  let delay = baseDelay

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options?.signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }

    try {
      await connectFn()
      return
    } catch (error) {
      if (attempt >= maxAttempts) throw error

      console.warn(
        `[${label}] connection attempt ${attempt} failed, retrying in ${delay}ms:`,
        error instanceof Error ? error.message : error
      )
      options?.onRetry?.(attempt, delay, error)

      await sleep(delay, options?.signal)
      delay = Math.min(delay * 2, maxDelay)
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      const err = new Error('Aborted')
      err.name = 'AbortError'
      reject(err)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
