import { useRef } from 'react'

export function arraysShallowEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Returns the previous array instance while the new one is shallow-equal.
 * Keeps downstream useMemo/useEffect dependencies referentially stable when a
 * parent rebuilds derived arrays every render (e.g. per streamed frame).
 */
export function useStableArray<T>(next: readonly T[]): readonly T[] {
  /* eslint-disable react-hooks/refs --
   * Render-phase memo cache, not a DOM ref: the write is idempotent (same
   * input array always yields the same stable reference), so StrictMode
   * double renders and concurrent re-renders at worst recompute the same
   * value. useState-during-render would instead queue an extra render on
   * every real change. */
  const stable = useRef(next)
  if (!arraysShallowEqual(stable.current, next)) {
    stable.current = next
  }
  return stable.current
  /* eslint-enable react-hooks/refs */
}
