import type { ProviderSettings } from '../../../../shared/yachiyo/protocol'
import type { ModelProviderOptionsMode } from '../types.ts'
import { createAnthropicProviderOptions } from './anthropic.ts'
import { createGatewayProviderOptions } from './gateway.ts'
import { createGoogleProviderOptions } from './google.ts'
import { createOpenAiProviderOptions } from './openai.ts'
import { createVertexProviderOptions } from './vertex.ts'
import type { RuntimeProviderOptions } from './shared.ts'

/**
 * Extract the thinking budget from resolved provider options, if any.
 * Gemini/Vertex count thinking tokens inside `maxOutputTokens`, so callers
 * can add this on top of the user's visible-output cap.
 */
export function extractThinkingBudget(options: RuntimeProviderOptions): number {
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
