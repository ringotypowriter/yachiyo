import type { LanguageModel } from 'ai'

import type { ProviderConfig, ProviderSettings } from '../../../../shared/yachiyo/protocol'
import type { ResolvedAiSdkRuntimeDependencies } from './dependencies.ts'
import {
  createDeepSeekV4ProMaxEffortFetch,
  isDeepSeekV4ProMaxEffortModel
} from './deepseekMaxEffort.ts'
import {
  cleanBaseUrl,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS,
  type RuntimeProviderOptions
} from './shared.ts'

export function createAnthropicLanguageModel(
  settings: ProviderSettings,
  dependencies: ResolvedAiSdkRuntimeDependencies
): LanguageModel {
  const maxEffortFetch =
    settings.thinkingEnabled !== false && isDeepSeekV4ProMaxEffortModel(settings.model)
      ? createDeepSeekV4ProMaxEffortFetch(
          {
            provider: 'anthropic',
            model: settings.model,
            thinkingEnabled: settings.thinkingEnabled
          },
          dependencies.fetchImpl
        )
      : undefined
  const provider = dependencies.createAnthropicProvider({
    apiKey: settings.apiKey,
    baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_ANTHROPIC_BASE_URL),
    ...(maxEffortFetch ? { fetch: maxEffortFetch } : {})
  })

  return provider(settings.model)
}

export function createAnthropicProviderOptions(
  settings: ProviderSettings,
  mode: 'default' | 'auxiliary'
): RuntimeProviderOptions {
  return {
    anthropic: {
      thinking: {
        ...(mode === 'auxiliary' || settings.thinkingEnabled === false
          ? { type: 'disabled' as const }
          : {
              type: 'enabled' as const,
              budgetTokens: DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS
            })
      }
    }
  }
}

export async function fetchAnthropicModels(
  provider: ProviderConfig,
  fetchImpl: typeof globalThis.fetch
): Promise<string[]> {
  const baseUrl = cleanBaseUrl(provider.baseUrl, DEFAULT_ANTHROPIC_BASE_URL)
  const url = `${baseUrl}/models?limit=100`
  console.log('[fetchModels] fetching anthropic:', url)
  const response = await fetchImpl(url, {
    headers: {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01'
    }
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const body = (await response.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((model) => model.id).sort()
}
