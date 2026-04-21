/**
 * Typed error contract for the run-execution retry state machine.
 *
 * The runExecution catch block has to decide between three outcomes:
 *
 *   1. cooperative abort   — `AbortController` signal is aborted; the
 *                            structured reason (RestartRunReason) decides
 *                            cancel vs. restart.
 *   2. retryable recovery  — a transient model/network failure; the run
 *                            checkpoints and resumes.
 *   3. fatal failure       — anything else (storage/ORM errors, tool
 *                            failures, programming bugs, ...).
 *
 * Only errors that were *explicitly* classified as retryable at a trusted
 * boundary (today: the model runtime) travel as `RetryableRunError`. The
 * catch block uses a single `instanceof` check — no shape matching — so
 * sqlite/drizzle/logic errors cannot masquerade as transient hiccups and
 * push the run into a perpetual retry loop.
 *
 * This module is the only place in the codebase allowed to inspect raw
 * SDK error shapes. Every other layer should consume the typed result.
 */

/**
 * The one retryable error class. Thrown at the model-runtime boundary
 * (for known transient transport failures) or from explicit retry-intent
 * code paths inside run execution (e.g. "model stream ended with
 * incomplete tool calls"). Carries the original cause so diagnostics
 * survive the wrap.
 */
export class RetryableRunError extends Error {
  override readonly name = 'RetryableRunError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export function isRetryableRunError(error: unknown): error is RetryableRunError {
  return error instanceof RetryableRunError
}

/**
 * Positive-signal classifier for raw errors caught at the model-runtime
 * boundary. Returns `true` only when the error carries a recognized
 * transient transport signal (explicit `isRetryable: true`, retryable
 * HTTP status, known network error code, or a known network error
 * message). Unknown errors default to `false` so storage/ORM/logic
 * errors never enter the retry path by accident.
 */
export function isTransientTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const explicit = (error as { isRetryable?: unknown }).isRetryable
  if (typeof explicit === 'boolean') return explicit

  const status =
    typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : undefined

  if (typeof status === 'number') {
    // status === 0 is what browser-side transport errors surface as.
    if (status === 0) return true
    if (status === 400 || status === 401 || status === 403 || status === 404) return false
    if (status === 429 || status >= 500) return true
    // Any other well-defined HTTP status (2xx/3xx/other 4xx) is not a
    // transient transport failure.
    return false
  }

  const code =
    typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ENETDOWN' ||
    code === 'ENETUNREACH' ||
    code === 'ENETRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ERR_CONNECTION_CLOSED' ||
    code === 'ERR_NETWORK_CHANGED' ||
    code === 'ERR_INTERNET_DISCONNECTED' ||
    code === 'ERR_HTTP2_PROTOCOL_ERROR' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true
  }

  const message = error instanceof Error ? error.message : ''
  if (
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ENETDOWN|ENETUNREACH|ENETRESET|EHOSTUNREACH|ERR_CONNECTION_CLOSED|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_HTTP2_PROTOCOL_ERROR|network (?:changed|is unreachable|is down)|fetch failed|socket hang up/i.test(
      message
    )
  ) {
    return true
  }

  return false
}

/**
 * Wrap an error thrown from the model-runtime boundary into the typed
 * retry contract. Transient transport errors become `RetryableRunError`
 * (preserving the original message and attaching the original as `cause`
 * for diagnostics); everything else — including `AbortError`, auth
 * failures, and unknown bugs — is returned as-is so callers can still
 * pattern-match on the original class. Idempotent.
 */
export function toRunBoundaryError(error: unknown): unknown {
  if (error instanceof RetryableRunError) return error
  if (!isTransientTransportError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new RetryableRunError(message, { cause: error })
}
