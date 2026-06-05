function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

const TRANSIENT_BROWSER_ERROR_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /ERR_CONNECTION_RESET/u,
  /ERR_CONNECTION_CLOSED/u,
  /ERR_TIMED_OUT/u,
  /ERR_NETWORK_CHANGED/u,
  /ERR_INTERNET_DISCONNECTED/u,
  /ERR_SSL_PROTOCOL_ERROR/u,
  /ERR_SSL_VERSION_OR_CIPHER_MISMATCH/u,
  /ERR_CERT_AUTHORITY_INVALID/u,
  /ERR_CERT_COMMON_NAME_INVALID/u,
  /ERR_CERT_DATE_INVALID/u,
  /ERR_CERT_INVALID/u,
  /ERR_CERT_WEAK_SIGNATURE_ALGORITHM/u,
  /\bSSL\b/i,
  /\bTLS\b/i,
  /certificate/i,
  /\bcert\b/i,
  /handshake/i,
  /frame.*detached/i,
  /target.*(?:closed|destroyed)/i
] as const

const NON_RETRYABLE_BROWSER_ERROR_PATTERNS = [
  /No browser session/i,
  /Browser session .* was destroyed/i,
  /Unknown ref/i,
  /Element not found for ref/i,
  /Ref is not/i,
  /script/i
] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isRetryableBrowserNavigationError(error: unknown): boolean {
  if (isAbortError(error)) return false

  const message = errorMessage(error)
  if (NON_RETRYABLE_BROWSER_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return false
  return TRANSIENT_BROWSER_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)

    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface BrowserRetryOptions<TResult> {
  attempts?: number
  delayMs?: number
  run: (attempt: number) => Promise<TResult>
  shouldRetryError?: (error: unknown, attempt: number) => boolean
  shouldRetryResult?: (result: TResult, attempt: number) => boolean
  signal?: AbortSignal
}

export async function runWithBrowserRetries<TResult>(
  input: BrowserRetryOptions<TResult>
): Promise<TResult> {
  const attempts = Math.max(1, input.attempts ?? 5)
  const delayMs = Math.max(0, input.delayMs ?? 350)
  let lastResult: TResult | undefined
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (input.signal?.aborted) {
      const error = new Error('Aborted')
      error.name = 'AbortError'
      throw error
    }

    try {
      const result = await input.run(attempt)
      lastResult = result

      if (
        !input.shouldRetryResult ||
        !input.shouldRetryResult(result, attempt) ||
        attempt >= attempts
      ) {
        return result
      }
    } catch (error) {
      const shouldRetryError = input.shouldRetryError?.(error, attempt) ?? true
      if (isAbortError(error) || !shouldRetryError || attempt >= attempts) {
        throw error
      }

      lastError = error
    }

    await sleep(delayMs * attempt, input.signal)
  }

  if (lastResult !== undefined) {
    return lastResult
  }

  throw lastError instanceof Error ? lastError : new Error('Browser operation failed.')
}
