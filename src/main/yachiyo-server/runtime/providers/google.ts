import type { LanguageModel } from 'ai'

import type { ProviderConfig, ProviderSettings } from '../../../../shared/yachiyo/protocol'
import type { ResolvedAiSdkRuntimeDependencies } from './dependencies.ts'
import {
  cleanBaseUrl,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_THINKING_BUDGET,
  type RuntimeProviderOptions
} from './shared.ts'

export function supportsGeminiThinking(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()

  return (
    normalized.startsWith('gemini-2.5') ||
    normalized.startsWith('gemini-3') ||
    normalized.startsWith('gemini-3.') ||
    normalized.includes('gemini-2.5') ||
    normalized.includes('gemini-3')
  )
}

const GEMINI_LEGACY_MAX_OUTPUT_TOKENS = 8192
const GEMINI_NEW_MAX_OUTPUT_TOKENS = 65536

export function getGeminiMaxOutputTokens(modelId: string): number {
  return supportsGeminiThinking(modelId)
    ? GEMINI_NEW_MAX_OUTPUT_TOKENS
    : GEMINI_LEGACY_MAX_OUTPUT_TOKENS
}

export function createGoogleLanguageModel(
  settings: ProviderSettings,
  dependencies: ResolvedAiSdkRuntimeDependencies
): LanguageModel {
  const provider = dependencies.createGoogleProvider({
    apiKey: settings.apiKey,
    baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_GEMINI_BASE_URL)
  })

  return provider(settings.model)
}

export function createGoogleProviderOptions(
  settings: ProviderSettings,
  mode: 'default' | 'auxiliary' = 'default'
): RuntimeProviderOptions {
  if (mode === 'auxiliary' && supportsGeminiThinking(settings.model)) {
    return {
      google: {
        thinkingConfig: {
          thinkingBudget: 0,
          includeThoughts: false
        }
      }
    }
  }
  return settings.thinkingEnabled !== false && supportsGeminiThinking(settings.model)
    ? {
        google: {
          thinkingConfig: {
            thinkingBudget: DEFAULT_GEMINI_THINKING_BUDGET,
            includeThoughts: true
          }
        }
      }
    : { google: {} }
}

export async function fetchGoogleModels(
  provider: ProviderConfig,
  fetchImpl: typeof globalThis.fetch
): Promise<string[]> {
  const baseUrl = cleanBaseUrl(provider.baseUrl, DEFAULT_GEMINI_BASE_URL)
  const url = `${baseUrl}/models?key=${encodeURIComponent(provider.apiKey)}&pageSize=100`
  console.log('[fetchModels] fetching gemini:', url)
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const body = (await response.json()) as { models?: Array<{ name: string }> }
  return (body.models ?? [])
    .map((model) => model.name.replace(/^models\//, ''))
    .filter((id) => id.startsWith('gemini'))
    .sort()
}
