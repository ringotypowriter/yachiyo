export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export function isValidJson(value: string): boolean {
  return tryParseJson(value) !== undefined
}
