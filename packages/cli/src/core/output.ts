const SENSITIVE_OUTPUT_FIELDS = new Set(['apiKey', 'serviceAccountPrivateKey'])

function redactSensitiveOutputValue(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value
  return '***'
}

export function outputJson(stdout: Pick<typeof process.stdout, 'write'>, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function sanitizeForOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForOutput)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_OUTPUT_FIELDS.has(k) ? redactSensitiveOutputValue(v) : sanitizeForOutput(v)
      ])
    )
  }
  return value
}
