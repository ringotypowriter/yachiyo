export const RECAP_IDLE_THRESHOLD_MS = 4 * 60 * 1000 + 55 * 1000
export const RECAP_IDLE_LABEL = '5 minutes'
export const RECAP_TOKEN_THRESHOLD = 32_000
export const RECAP_MESSAGE_THRESHOLD = 5

export function hasRecapIdleThresholdElapsed(
  updatedAtMs: number,
  nowMs: number = Date.now()
): boolean {
  return nowMs - updatedAtMs >= RECAP_IDLE_THRESHOLD_MS
}

export interface RecapEligibilityInput {
  recapEnabled: boolean
  isExternalThread: boolean
  isAcpThread: boolean
  hasActiveRun: boolean
  isEditingMessage: boolean
  messageCount: number
  lastPromptTokens: number
  hasExistingRecap: boolean
  updatedAtMs: number
  nowMs?: number
}

export type RecapDecision =
  | { action: 'skip' }
  | { action: 'fire' }
  | { action: 'schedule'; delayMs: number }

export function computeRecapDecision(input: RecapEligibilityInput): RecapDecision {
  if (!input.recapEnabled) return { action: 'skip' }
  if (input.isExternalThread) return { action: 'skip' }
  if (input.isAcpThread) return { action: 'skip' }
  if (input.hasActiveRun) return { action: 'skip' }
  if (input.isEditingMessage) return { action: 'skip' }
  if (
    input.messageCount <= RECAP_MESSAGE_THRESHOLD &&
    input.lastPromptTokens <= RECAP_TOKEN_THRESHOLD
  )
    return { action: 'skip' }
  if (input.hasExistingRecap) return { action: 'skip' }

  const now = input.nowMs ?? Date.now()
  const remaining = RECAP_IDLE_THRESHOLD_MS - (now - input.updatedAtMs)

  if (remaining <= 0) return { action: 'fire' }
  return { action: 'schedule', delayMs: remaining }
}
