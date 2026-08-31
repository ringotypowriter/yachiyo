export function parseStrictObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object.')
  }
  return parsed as Record<string, unknown>
}

export function hasExactKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...names].sort()
  return (
    actual.length === expected.length && actual.every((name, index) => name === expected[index])
  )
}
