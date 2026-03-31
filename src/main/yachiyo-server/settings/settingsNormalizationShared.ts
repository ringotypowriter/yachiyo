export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(value.map((item) => normalizeString(item, '')).filter(Boolean))]
}

export function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined
  }

  return value
}

export function normalizeOptionalBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
