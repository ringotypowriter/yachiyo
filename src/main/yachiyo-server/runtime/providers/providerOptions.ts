import type { ProviderSettings } from '../../../../shared/yachiyo/protocol'
import type { ModelProviderOptionsMode } from '../types.ts'
import { createAnthropicProviderOptions } from './anthropic.ts'
import { createGatewayProviderOptions } from './gateway.ts'
import { createGoogleProviderOptions } from './google.ts'
import { createOpenAiProviderOptions } from './openai.ts'
import { createVertexProviderOptions } from './vertex.ts'
import { THINKING_INSIDE_MAX_OUTPUT_HOSTS, type RuntimeProviderOptions } from './shared.ts'

function matchesThinkingInsideMaxOutputHost(settings?: ProviderSettings): boolean {
  if (!settings) return false
  try {
    const host = new URL(settings.baseUrl).host
    return THINKING_INSIDE_MAX_OUTPUT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

/**
 * Whether this provider counts thinking tokens inside `maxOutputTokens`.
 * Google, Vertex, and select anthropic-compatible hosts (e.g. Kimi) all
 * exhibit this behaviour. The runtime inflates the cap by the thinking
 * budget so the user's visible-output limit is preserved.
 */
export function countsThinkingInsideMaxOutput(
  options: RuntimeProviderOptions,
  settings?: ProviderSettings
): boolean {
  if ('google' in options) return true
  if ('vertex' in options && !('gateway' in options)) return true
  if ('anthropic' in options && matchesThinkingInsideMaxOutputHost(settings)) return true
  return false
}

/**
 * Extract the thinking budget from resolved provider options, if any.
 * Returns 0 when the provider does not count thinking tokens inside
 * `maxOutputTokens` or when thinking is disabled.
 */
export function extractThinkingBudget(
  options: RuntimeProviderOptions,
  settings?: ProviderSettings
): number {
  if (!countsThinkingInsideMaxOutput(options, settings)) return 0

  if ('google' in options) {
    return (
      (options as { google: { thinkingConfig?: { thinkingBudget?: number } } }).google
        .thinkingConfig?.thinkingBudget ?? 0
    )
  }
  if ('vertex' in options && !('gateway' in options)) {
    return (
      (options as { vertex: { thinkingConfig?: { thinkingBudget?: number } } }).vertex
        .thinkingConfig?.thinkingBudget ?? 0
    )
  }
  if ('anthropic' in options) {
    const thinking = (
      options as { anthropic: { thinking?: { type?: string; budgetTokens?: number } } }
    ).anthropic.thinking
    return thinking?.type === 'enabled' ? (thinking.budgetTokens ?? 0) : 0
  }
  return 0
}

export function createProviderOptions(
  settings: ProviderSettings,
  mode: ModelProviderOptionsMode = 'default'
): RuntimeProviderOptions {
  if (settings.provider === 'openai' || settings.provider === 'openai-responses') {
    return createOpenAiProviderOptions(settings, mode)
  }

  if (settings.provider === 'gemini') {
    return createGoogleProviderOptions(settings)
  }

  if (settings.provider === 'vertex') {
    return createVertexProviderOptions(settings)
  }

  if (settings.provider === 'vercel-gateway') {
    return createGatewayProviderOptions(settings)
  }

  return createAnthropicProviderOptions(settings, mode)
}
