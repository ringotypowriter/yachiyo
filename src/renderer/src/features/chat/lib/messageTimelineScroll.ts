export type InitialBottomScrollDecision = 'done' | 'retry'

export interface TimelineScrollMetrics {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

export const INITIAL_BOTTOM_SCROLL_MAX_ATTEMPTS = 8
export const TIMELINE_BOTTOM_TOLERANCE_PX = 4

export function getInitialBottomScrollDecision(input: {
  attempt: number
  metrics: TimelineScrollMetrics | null
  maxAttempts?: number
  tolerancePx?: number
}): InitialBottomScrollDecision {
  const maxAttempts = input.maxAttempts ?? INITIAL_BOTTOM_SCROLL_MAX_ATTEMPTS
  if (input.attempt >= maxAttempts) return 'done'

  const metrics = input.metrics
  if (!metrics || metrics.clientHeight <= 0) return 'retry'

  const tolerancePx = input.tolerancePx ?? TIMELINE_BOTTOM_TOLERANCE_PX
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  return maxScrollTop - metrics.scrollTop <= tolerancePx ? 'done' : 'retry'
}
