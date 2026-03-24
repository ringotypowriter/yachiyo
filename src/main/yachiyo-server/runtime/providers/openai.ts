import type { LanguageModel } from 'ai'

import type { ProviderConfig, ProviderSettings } from '../../../../shared/yachiyo/protocol'
import type { ResolvedAiSdkRuntimeDependencies } from './dependencies.ts'
import {
  cleanBaseUrl,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_REASONING_EFFORT,
  type RuntimeProviderOptions
} from './shared.ts'

export function supportsOpenAIReasoningEffort(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()

  return (
    normalized.startsWith('gpt-5') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  )
}

export function shouldUseOpenAIResponsesApi(settings: ProviderSettings): boolean {
  return (
    settings.provider === 'openai-responses' ||
    (settings.provider === 'openai' && supportsOpenAIReasoningEffort(settings.model))
  )
}

export function createOpenAiLanguageModel(
  settings: ProviderSettings,
  dependencies: ResolvedAiSdkRuntimeDependencies,
  mode: 'default' | 'auxiliary',
  diagnosticFetch?: typeof globalThis.fetch
): LanguageModel {
  const provider = dependencies.createOpenAIProvider({
    apiKey: settings.apiKey,
    baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_OPENAI_BASE_URL),
    ...(diagnosticFetch ? { fetch: diagnosticFetch } : {})
  })

  if (shouldUseOpenAIResponsesApi(settings)) {
    return mode === 'auxiliary' ? provider.chat(settings.model) : provider.responses(settings.model)
  }

  return provider.chat(settings.model)
}

export function createOpenAiProviderOptions(
  settings: ProviderSettings,
  mode: 'default' | 'auxiliary'
): RuntimeProviderOptions {
  const reasoningEffort =
    mode === 'default' && supportsOpenAIReasoningEffort(settings.model)
      ? DEFAULT_OPENAI_REASONING_EFFORT
      : undefined

  return {
    openai: {
      ...(reasoningEffort ? { reasoningEffort } : {}),
      store: false
    }
  }
}

export async function fetchOpenAiCompatibleModels(
  provider: ProviderConfig,
  fetchImpl: typeof globalThis.fetch
): Promise<string[]> {
  const baseUrl = cleanBaseUrl(provider.baseUrl, DEFAULT_OPENAI_BASE_URL)
  const url = `${baseUrl}/models`
  console.log('[fetchModels] fetching openai-compatible:', url)
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${provider.apiKey}` }
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const body = (await response.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((model) => model.id).sort()
}
