export const RECAP_IDLE_THRESHOLD_MS = 4 * 60 * 1000 + 55 * 1000
export const RECAP_IDLE_LABEL = '5 minutes'

export function hasRecapIdleThresholdElapsed(
  updatedAtMs: number,
  nowMs: number = Date.now()
): boolean {
  return nowMs - updatedAtMs >= RECAP_IDLE_THRESHOLD_MS
}
