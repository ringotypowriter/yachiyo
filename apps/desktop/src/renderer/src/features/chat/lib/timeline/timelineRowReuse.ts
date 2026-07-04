import { useRef } from 'react'

import type { MessageTimelineRow } from './messageTimelineRows.ts'

/**
 * Rows nest as row → group → branches[] → branch → message; the limit lets the
 * comparison reach message references (which are identity-stable for completed
 * messages) while never descending into message internals like responseMessages.
 */
const MAX_COMPARE_DEPTH = 5

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function structurallyEqual(left: unknown, right: unknown, depth: number): boolean {
  if (left === right) return true
  if (depth === 0) return false

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      if (!structurallyEqual(left[index], right[index], depth - 1)) return false
    }
    return true
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key)) return false
      if (!structurallyEqual(left[key], right[key], depth - 1)) return false
    }
    return true
  }

  return false
}

/**
 * Timeline rows are rebuilt from scratch on every store update (every streamed
 * frame while a reply is in flight), which breaks the reference-equality memo
 * on row components for rows whose content did not change. This maps each fresh
 * row back to its previous instance when it is structurally identical, so
 * unchanged rows keep their identity and skip re-rendering.
 */
export function reuseTimelineRows(
  previous: readonly MessageTimelineRow[],
  next: readonly MessageTimelineRow[]
): readonly MessageTimelineRow[] {
  if (previous === next) return previous

  const previousByKey = new Map<string, MessageTimelineRow>()
  for (const row of previous) {
    previousByKey.set(row.key, row)
  }

  let reusedAll = previous.length === next.length
  const result = next.map((row, index) => {
    const candidate = previousByKey.get(row.key)
    if (candidate && structurallyEqual(candidate, row, MAX_COMPARE_DEPTH)) {
      if (candidate !== previous[index]) reusedAll = false
      return candidate
    }
    reusedAll = false
    return row
  })

  return reusedAll ? previous : result
}

/** Stateful wrapper: reuse row identities against whatever the last render produced. */
export function useReusedTimelineRows(
  next: readonly MessageTimelineRow[]
): readonly MessageTimelineRow[] {
  /* eslint-disable react-hooks/refs --
   * Render-phase memo cache, not a DOM ref: the write is idempotent (same
   * inputs always produce the same reused array), so StrictMode double
   * renders and concurrent re-renders at worst recompute the same value.
   * The useState alternative would setState-during-render on every streamed
   * frame, doubling render work in exactly the hot path this exists to fix. */
  const rows = useRef(next)
  rows.current = reuseTimelineRows(rows.current, next)
  return rows.current
  /* eslint-enable react-hooks/refs */
}
