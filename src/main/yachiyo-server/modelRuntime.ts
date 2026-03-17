import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { stepCountIs, streamText, type LanguageModel } from 'ai'

import type { ProviderConfig, ProviderSettings } from '../../shared/yachiyo/protocol'
import { prepareAiSdkMessages } from './messagePrepare.ts'
import type { ModelRuntime } from './types.ts'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const DEFAULT_OPENAI_REASONING_EFFORT = 'medium'
const DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS = 1024

type OpenAIProviderFactory = typeof createOpenAI
type AnthropicProviderFactory = typeof createAnthropic
type StreamTextImplementation = typeof streamText

type OpenAiRuntimeProviderOptions = {
  openai: {
    reasoningEffort: string
    store: false
  }
}

type AnthropicRuntimeProviderOptions = {
  anthropic: {
    thinking: {
      type: 'enabled'
      budgetTokens: number
    }
  }
}

type RuntimeProviderOptions = OpenAiRuntimeProviderOptions | AnthropicRuntimeProviderOptions

export interface AiSdkRuntimeDependencies {
  createAnthropicProvider?: AnthropicProviderFactory
  createOpenAIProvider?: OpenAIProviderFactory
  streamTextImpl?: StreamTextImplementation
}

function cleanBaseUrl(baseUrl: string, fallback: string): string {
  return (baseUrl.trim() || fallback).replace(/\/+$/, '')
}

function assertConfigured(settings: ProviderSettings): void {
  if (!settings.apiKey.trim()) {
    throw new Error('No API key configured. Open Settings and add a provider key first.')
  }

  if (!settings.model.trim()) {
    throw new Error('No model configured. Open Settings and choose a model first.')
  }
}

function createLanguageModel(
  settings: ProviderSettings,
  dependencies: Required<AiSdkRuntimeDependencies>
): LanguageModel {
  if (settings.provider === 'openai') {
    const provider = dependencies.createOpenAIProvider({
      apiKey: settings.apiKey,
      baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_OPENAI_BASE_URL)
    })
    return provider.responses(settings.model)
  }

  const provider = dependencies.createAnthropicProvider({
    apiKey: settings.apiKey,
    baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_ANTHROPIC_BASE_URL)
  })
  return provider(settings.model)
}

function createProviderOptions(settings: ProviderSettings): RuntimeProviderOptions {
  if (settings.provider === 'openai') {
    return {
      openai: {
        reasoningEffort: DEFAULT_OPENAI_REASONING_EFFORT,
        // Keep tool-call context inline for proxy compatibility instead of
        // depending on provider-side item storage across tool steps.
        store: false
      }
    }
  }

  return {
    anthropic: {
      thinking: {
        type: 'enabled',
        budgetTokens: DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS
      }
    }
  }
}

interface ModelsResponseItem {
  id: string
}

export async function fetchModels(provider: ProviderConfig): Promise<string[]> {
  const fallbackBase =
    provider.type === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL
  const baseUrl = cleanBaseUrl(provider.baseUrl, fallbackBase)

  if (!provider.apiKey.trim()) {
    throw new Error('API key is required')
  }

  if (provider.type === 'anthropic') {
    const url = `${baseUrl}/models?limit=100`
    console.log('[fetchModels] fetching anthropic:', url)
    const response = await fetch(url, {
      headers: {
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01'
      }
    })
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    const body = (await response.json()) as { data: ModelsResponseItem[] }
    return (body.data ?? []).map((m) => m.id).sort()
  }

  // OpenAI-compatible
  const url = `${baseUrl}/models`
  console.log('[fetchModels] fetching openai:', url)
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${provider.apiKey}` }
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const body = (await response.json()) as { data: ModelsResponseItem[] }
  return (body.data ?? []).map((m) => m.id).sort()
}

export function createAiSdkModelRuntime(dependencies: AiSdkRuntimeDependencies = {}): ModelRuntime {
  const resolvedDependencies: Required<AiSdkRuntimeDependencies> = {
    createAnthropicProvider: dependencies.createAnthropicProvider ?? createAnthropic,
    createOpenAIProvider: dependencies.createOpenAIProvider ?? createOpenAI,
    streamTextImpl: dependencies.streamTextImpl ?? streamText
  }

  return {
    async *streamReply(request) {
      assertConfigured(request.settings)

      const result = resolvedDependencies.streamTextImpl({
        abortSignal: request.signal,
        messages: prepareAiSdkMessages(request.messages),
        model: createLanguageModel(request.settings, resolvedDependencies),
        providerOptions: createProviderOptions(request.settings),
        ...(request.tools ? { tools: request.tools, stopWhen: stepCountIs(20) } : {}),
        ...(request.onToolCallStart
          ? { experimental_onToolCallStart: request.onToolCallStart }
          : {}),
        ...(request.onToolCallFinish
          ? { experimental_onToolCallFinish: request.onToolCallFinish }
          : {})
      })

      for await (const textPart of result.textStream) {
        if (textPart) {
          yield textPart
        }
      }
    }
  }
}
