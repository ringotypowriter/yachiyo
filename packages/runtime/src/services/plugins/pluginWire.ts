/** Self-contained: its compiled function is also embedded in the worker. */
export function normalizePluginValue(value: unknown): unknown {
  function normalize(input: unknown): unknown {
    if (input instanceof URL) return input.href
    if (Array.isArray(input)) return input.map(normalize)
    if (input !== null && typeof input === 'object') {
      const prototype = Object.getPrototypeOf(input)
      if (prototype === Object.prototype || prototype === null) {
        return Object.fromEntries(
          Object.entries(input).map(([key, child]) => [key, normalize(child)])
        )
      }
    }
    return input
  }
  return normalize(value)
}
