function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
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
  shouldRetryResult?: (result: TResult, attempt: number) => boolean
  signal?: AbortSignal
}

export async function runWithBrowserRetries<TResult>(
  input: BrowserRetryOptions<TResult>
): Promise<TResult> {
  const attempts = Math.max(1, input.attempts ?? 3)
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
      if (isAbortError(error) || attempt >= attempts) {
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
