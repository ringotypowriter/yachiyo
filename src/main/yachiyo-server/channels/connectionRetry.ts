/**
 * Shared connection retry with exponential backoff.
 *
 * Used by channel services (Discord, Telegram) to retry the initial connection
 * when the remote server is unavailable. QQ/OneBot has its own built-in
 * reconnect loop in onebotClient.ts, so it doesn't use this.
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
