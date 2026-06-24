import type { LanguageModel } from 'ai'

import type { ProviderConfig, ProviderSettings } from '@yachiyo/shared/protocol'
import { isOpenAIXHighReasoningEffortModel } from '@yachiyo/shared/reasoningEffort'
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

function toOpenAIReasoningEffort(
  model: string,
  effort: ProviderSettings['reasoningEffort']
): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (effort === undefined) {
    return DEFAULT_OPENAI_REASONING_EFFORT
  }
  if (effort === 'off') {
    return undefined
  }
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    return effort
  }
  if (effort === 'xhigh' && isOpenAIXHighReasoningEffortModel(model)) {
    return effort
  }

  throw new Error(`OpenAI reasoning effort "${effort}" is not supported.`)
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
            thinkingEnabled: settings.thinkingEnabled,
            reasoningEffort: settings.reasoningEffort
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
    // Auxiliary (tool-model) calls normally drop to the cheaper chat endpoint, but a
    // dedicated Responses-API backend (`openai-responses`, `openai-codex`) only speaks
    // /responses — calling chat() there hits an unsupported endpoint, so it could never
    // serve as a tool model. Only the plain `openai` provider, which merely opted into
    // responses for reasoning, falls back to chat() for auxiliary; the responses
    // backends stay on responses() in both modes.
    const useChatForAuxiliary = mode === 'auxiliary' && settings.provider === 'openai'
    return useChatForAuxiliary ? provider.chat(settings.model) : provider.responses(settings.model)
  }

  return provider.chat(settings.model)
}

export function createOpenAiProviderOptions(
  settings: ProviderSettings,
  mode: 'default' | 'auxiliary'
): RuntimeProviderOptions {
  const enableReasoningPreview =
    settings.thinkingEnabled !== false &&
    settings.reasoningEffort !== 'off' &&
    mode === 'default' &&
    supportsOpenAIReasoningEffort(settings.model)
  const reasoningEffort = enableReasoningPreview
    ? toOpenAIReasoningEffort(settings.model, settings.reasoningEffort)
    : undefined
  const isGpt5 = settings.model.trim().toLowerCase().startsWith('gpt-5')
  const useResponsesApi = shouldUseOpenAIResponsesApi(settings)

  return {
    openai: {
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(enableReasoningPreview ? { reasoningSummary: 'detailed' as const } : {}),
      ...(isGpt5 ? { textVerbosity: 'low' as const } : {}),
      ...(mode === 'default' && useResponsesApi
        ? { include: ['reasoning.encrypted_content' as const] }
        : {}),
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
  const url = isCodexOauth ? `${baseUrl}/models?client_version=0.134.0` : `${baseUrl}/models`
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
