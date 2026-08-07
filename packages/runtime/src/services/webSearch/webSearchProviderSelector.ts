import type { WebSearchFailureCode } from '@yachiyo/shared/protocol'
import type { WebSearchProvider } from './webSearchService.ts'

const EWMA_ALPHA = 0.25
const SUCCESS_RATE_WEIGHT = 4
const MAX_LATENCY_PENALTY = 2
const LATENCY_PENALTY_WINDOW_MS = 5_000
const CONSECUTIVE_FAILURE_PENALTY = 2
const IN_FLIGHT_PENALTY = 3
const EXPLORATION_REWARD_PER_MINUTE = 1
const MAX_EXPLORATION_REWARD = 5
const TRANSIENT_COOLDOWN_MS = 60_000
const PROVIDER_COOLDOWN_MS = 15 * 60_000

export interface WebSearchProviderRegistration {
  baseWeight: number
  provider: WebSearchProvider
}

export interface WebSearchProviderState {
  consecutiveFailures: number
  cooldownUntil: number
  inFlight: number
  lastAttemptAt: number
  latencyMs: number
  successRate: number
}

export interface WebSearchProviderSelector {
  begin(providerId: string): void
  complete(providerId: string, latencyMs: number, failureCode?: WebSearchFailureCode): void
  getState(providerId: string): Readonly<WebSearchProviderState> | undefined
  select(attemptedProviderIds: ReadonlySet<string>): WebSearchProviderRegistration | undefined
}

interface ProviderEntry extends WebSearchProviderRegistration {
  state: WebSearchProviderState
}

function updateEwma(current: number, sample: number): number {
  return current * (1 - EWMA_ALPHA) + sample * EWMA_ALPHA
}

function cooldownFor(failureCode: WebSearchFailureCode): number {
  if (failureCode === 'provider-failed') {
    return PROVIDER_COOLDOWN_MS
  }

  if (
    failureCode === 'timeout' ||
    failureCode === 'load-failed' ||
    failureCode === 'extraction-failed'
  ) {
    return TRANSIENT_COOLDOWN_MS
  }

  return 0
}

function score(entry: ProviderEntry, now: number): number {
  const state = entry.state
  const latencyPenalty = Math.min(
    (state.latencyMs / LATENCY_PENALTY_WINDOW_MS) * MAX_LATENCY_PENALTY,
    MAX_LATENCY_PENALTY
  )
  const idleMinutes = Math.max(0, now - state.lastAttemptAt) / 60_000
  const explorationReward = Math.min(
    idleMinutes * EXPLORATION_REWARD_PER_MINUTE,
    MAX_EXPLORATION_REWARD
  )

  return (
    entry.baseWeight +
    state.successRate * SUCCESS_RATE_WEIGHT -
    latencyPenalty -
    state.consecutiveFailures * CONSECUTIVE_FAILURE_PENALTY -
    state.inFlight * IN_FLIGHT_PENALTY +
    explorationReward
  )
}

export function createWebSearchProviderSelector(input: {
  now?: () => number
  providers: WebSearchProviderRegistration[]
}): WebSearchProviderSelector {
  const now = input.now ?? Date.now
  const entries = input.providers.map<ProviderEntry>((registration) => ({
    ...registration,
    state: {
      consecutiveFailures: 0,
      cooldownUntil: 0,
      inFlight: 0,
      lastAttemptAt: now(),
      latencyMs: 0,
      successRate: 0.5
    }
  }))
  const entriesById = new Map(entries.map((entry) => [entry.provider.id, entry]))

  return {
    begin(providerId) {
      const state = entriesById.get(providerId)?.state
      if (!state) {
        return
      }

      state.inFlight += 1
      state.lastAttemptAt = now()
    },
    complete(providerId, latencyMs, failureCode) {
      const state = entriesById.get(providerId)?.state
      if (!state) {
        return
      }

      state.inFlight = Math.max(0, state.inFlight - 1)

      if (failureCode === 'aborted' || failureCode === 'invalid-query') {
        return
      }

      state.latencyMs = state.latencyMs === 0 ? latencyMs : updateEwma(state.latencyMs, latencyMs)
      state.successRate = updateEwma(state.successRate, failureCode ? 0 : 1)

      if (!failureCode) {
        state.consecutiveFailures = 0
        state.cooldownUntil = 0
        return
      }

      state.consecutiveFailures += 1
      state.cooldownUntil = now() + cooldownFor(failureCode)
    },
    getState(providerId) {
      return entriesById.get(providerId)?.state
    },
    select(attemptedProviderIds) {
      const currentTime = now()
      let selected: ProviderEntry | undefined
      let selectedScore = Number.NEGATIVE_INFINITY

      for (const entry of entries) {
        if (
          attemptedProviderIds.has(entry.provider.id) ||
          currentTime < entry.state.cooldownUntil ||
          entry.provider.isAvailable?.() === false
        ) {
          continue
        }

        const currentScore = score(entry, currentTime)
        if (currentScore > selectedScore) {
          selected = entry
          selectedScore = currentScore
        }
      }

      return selected
    }
  }
}
