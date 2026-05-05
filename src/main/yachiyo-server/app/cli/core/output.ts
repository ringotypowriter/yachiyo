export function outputJson(stdout: Pick<typeof process.stdout, 'write'>, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function sanitizeForOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForOutput)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        k === 'apiKey' && typeof v === 'string' ? (v ? '***' : '') : sanitizeForOutput(v)
      ])
    )
  }
  return value
}
