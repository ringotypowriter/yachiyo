import type { ProviderConfig } from '../../../../shared/yachiyo/protocol'
import type { FetchModelsDependencies } from './dependencies.ts'
import { fetchAnthropicModels } from './anthropic.ts'
import { fetchGatewayModels } from './gateway.ts'
import { fetchGoogleModels } from './google.ts'
import { fetchOpenAiCompatibleModels } from './openai.ts'
import { fetchVertexModels } from './vertex.ts'

export async function fetchModels(
  provider: ProviderConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  dependencies: FetchModelsDependencies = {}
): Promise<string[]> {
  if (
    provider.type === 'openai-codex' &&
    !provider.apiKey.trim() &&
    !provider.codexSessionPath?.trim()
  ) {
    throw new Error('Codex session path is required')
  }

  if (!provider.apiKey.trim() && provider.type !== 'vertex' && provider.type !== 'openai-codex') {
    throw new Error('API key is required')
  }

  if (provider.type === 'anthropic') {
    return fetchAnthropicModels(provider, fetchImpl)
  }

  if (provider.type === 'gemini') {
    return fetchGoogleModels(provider, fetchImpl)
  }

  if (provider.type === 'vertex') {
    return fetchVertexModels(provider, fetchImpl, dependencies)
  }

  if (provider.type === 'vercel-gateway') {
    return fetchGatewayModels(provider)
  }

  return fetchOpenAiCompatibleModels(provider, fetchImpl)
}
