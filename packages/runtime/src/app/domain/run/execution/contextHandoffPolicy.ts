import { DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD } from '@yachiyo/shared/protocol'

export interface ContextHandoffThresholdConfig {
  chat?: {
    stripCompact?: boolean
    stripCompactThresholdTokens?: number
  }
}

export function resolveContextHandoffThreshold(
  config: ContextHandoffThresholdConfig
): number | null {
  if (config.chat?.stripCompact === false) return null
  const threshold =
    config.chat?.stripCompactThresholdTokens ?? DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD
  return Math.max(1, Math.floor(threshold))
}

export function shouldTriggerContextHandoffForActualPromptTokens(input: {
  actualPromptTokens?: number
  thresholdTokens: number | null
}): boolean {
  return (
    input.thresholdTokens != null &&
    input.actualPromptTokens != null &&
    input.actualPromptTokens >= input.thresholdTokens
  )
}
