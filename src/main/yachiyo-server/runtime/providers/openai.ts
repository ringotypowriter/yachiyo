import type { LanguageModel } from 'ai'

import type { ProviderConfig, ProviderSettings } from '../../../../shared/yachiyo/protocol'
import type { ResolvedAiSdkRuntimeDependencies } from './dependencies.ts'
import {
  createDeepSeekV4ProMaxEffortFetch,
  isDeepSeekV4ProMaxEffortModel
} from './deepseekMaxEffort.ts'
import { createCacheFetch } from './openaiCompatibleCache.ts'
import { createThinkingFetch, type ThinkingFetchOptions } from './openaiCompatibleThinking.ts'
import { readCodexSessionAuth } from './codexSessionAuth.ts'
import {
  cleanBaseUrl,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_REASONING_EFFORT,
  type RuntimeProviderOptions
} from './shared.ts'

const CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex'

function buildCodexHeaders(accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'codex_cli_rs/0.0.0 (Hermes Agent)',
    originator: 'codex_cli_rs'
  }
  if (accountId) {
    headers['ChatGPT-Account-ID'] = accountId
  }
  return headers
}

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
    settings.provider === 'openai-codex' ||
    (settings.provider === 'openai' && supportsOpenAIReasoningEffort(settings.model))
  )
}

export interface OpenAiLanguageModelOptions {
  onReasoningDelta?: (delta: string) => void
  historicalReasoningContents?: string[]
}

export function createOpenAiLanguageModel(
  settings: ProviderSettings,
  dependencies: ResolvedAiSdkRuntimeDependencies,
  mode: 'default' | 'auxiliary',
  diagnosticFetch?: typeof globalThis.fetch,
  options: OpenAiLanguageModelOptions = {}
): LanguageModel {
  const thinkingOptions: ThinkingFetchOptions = {
    onReasoningDelta: options.onReasoningDelta,
    historicalReasoningContents: options.historicalReasoningContents
  }

  // Layer fetch wrappers (innermost → outermost):
  //   realFetch → cacheFetch (inject cache_control) → thinkingFetch (inject reasoning params)
  //   → maxEffortFetch (DeepSeek v4 Pro chat-completions effort)
  // When diagnosticFetch is present it replaces globalThis.fetch as the
  // innermost transport for logging, and the same chain stacks on top.
  const innerFetch = diagnosticFetch ?? globalThis.fetch
  const cacheFetch = createCacheFetch(settings.baseUrl, innerFetch)
  const thinkingFetch = createThinkingFetch(
    settings,
    mode,
    cacheFetch ?? innerFetch,
    thinkingOptions
  )
  const maxEffortFetch =
    settings.thinkingEnabled !== false && isDeepSeekV4ProMaxEffortModel(settings.model)
      ? createDeepSeekV4ProMaxEffortFetch(
          {
            provider: 'openai',
            model: settings.model,
            thinkingEnabled: settings.thinkingEnabled
          },
          thinkingFetch ?? cacheFetch ?? innerFetch
        )
      : undefined
  const composedFetch = maxEffortFetch ?? thinkingFetch ?? cacheFetch

  const isCodexOauth = settings.provider === 'openai-codex'
  const provider = dependencies.createOpenAIProvider({
    apiKey: settings.apiKey,
    baseURL: isCodexOauth
      ? CODEX_BACKEND_BASE_URL
      : cleanBaseUrl(settings.baseUrl, DEFAULT_OPENAI_BASE_URL),
    ...(isCodexOauth ? { headers: buildCodexHeaders(settings.codexAccountId) } : {}),
    ...(composedFetch ? { fetch: composedFetch } : {})
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
  const enableReasoningPreview =
    settings.thinkingEnabled !== false &&
    mode === 'default' &&
    supportsOpenAIReasoningEffort(settings.model)
  const reasoningEffort = enableReasoningPreview ? DEFAULT_OPENAI_REASONING_EFFORT : undefined
  const isGpt5 = settings.model.trim().toLowerCase().startsWith('gpt-5')

  return {
    openai: {
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(enableReasoningPreview ? { reasoningSummary: 'auto' as const } : {}),
      ...(isGpt5 ? { textVerbosity: 'low' as const } : {}),
      store: false
    }
  }
}

export async function fetchOpenAiCompatibleModels(
  provider: ProviderConfig,
  fetchImpl: typeof globalThis.fetch
): Promise<string[]> {
  const isCodexOauth = provider.type === 'openai-codex'
  const baseUrl = isCodexOauth
    ? CODEX_BACKEND_BASE_URL
    : cleanBaseUrl(provider.baseUrl, DEFAULT_OPENAI_BASE_URL)
  const url = isCodexOauth ? `${baseUrl}/models?client_version=0.125.0` : `${baseUrl}/models`
  console.log('[fetchModels] fetching openai-compatible:', url)

  let apiKey = provider.apiKey
  let accountId: string | undefined
  if (isCodexOauth && provider.codexSessionPath?.trim()) {
    const result = await readCodexSessionAuth(provider.codexSessionPath)
    apiKey = result.accessToken
    accountId = result.accountId
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  if (isCodexOauth && accountId) {
    headers['ChatGPT-Account-ID'] = accountId
  }

  const response = await fetchImpl(url, {
    headers
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }

  if (isCodexOauth) {
    const body = (await response.json()) as {
      models?: Array<{ slug: string; visibility?: string; supported_in_api?: boolean }>
    }
    return (body.models ?? [])
      .filter((m) => m.visibility === 'list' && m.supported_in_api !== false)
      .map((m) => m.slug)
      .sort()
  }

  const body = (await response.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((model) => model.id).sort()
}
