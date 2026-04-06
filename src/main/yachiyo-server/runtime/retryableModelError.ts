export function isRetryableModelError(error: unknown): boolean {
  const explicitRetryable =
    typeof (error as { isRetryable?: unknown })?.isRetryable === 'boolean'
      ? ((error as { isRetryable: boolean }).isRetryable as boolean)
      : undefined
  if (explicitRetryable !== undefined) {
    return explicitRetryable
  }

  const status =
    typeof (error as { status?: unknown })?.status === 'number'
      ? ((error as { status: number }).status as number)
      : typeof (error as { statusCode?: unknown })?.statusCode === 'number'
        ? ((error as { statusCode: number }).statusCode as number)
        : undefined

  if (status !== undefined) {
    if (status === 0) return true
    if (status === 400 || status === 401 || status === 403 || status === 404) return false
    if (status === 429 || status >= 500) return true
  }

  const code =
    typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : undefined
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ERR_CONNECTION_CLOSED' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true
  }

  const message = error instanceof Error ? error.message : String(error)
  if (
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ERR_CONNECTION_CLOSED|fetch failed|socket hang up/i.test(
      message
    )
  ) {
    return true
  }

  return status === undefined
}
