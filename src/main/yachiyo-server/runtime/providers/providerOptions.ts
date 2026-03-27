import type { ProviderSettings } from '../../../../shared/yachiyo/protocol'
import type { ModelProviderOptionsMode } from '../types.ts'
import { createAnthropicProviderOptions } from './anthropic.ts'
import { createGatewayProviderOptions } from './gateway.ts'
import { createGoogleProviderOptions } from './google.ts'
import { createOpenAiProviderOptions } from './openai.ts'
import { createVertexProviderOptions } from './vertex.ts'
import type { RuntimeProviderOptions } from './shared.ts'

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
