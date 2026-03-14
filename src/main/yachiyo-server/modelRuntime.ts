import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText, type LanguageModel } from 'ai'

import type { ProviderSettings } from '../../shared/yachiyo/protocol'
import { prepareAiSdkMessages } from './messagePrepare.ts'
import type { ModelRuntime } from './types.ts'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'

type OpenAIProviderFactory = typeof createOpenAI
type AnthropicProviderFactory = typeof createAnthropic
type StreamTextImplementation = typeof streamText

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
    return provider.chat(settings.model)
  }

  const provider = dependencies.createAnthropicProvider({
    apiKey: settings.apiKey,
    baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_ANTHROPIC_BASE_URL)
  })
  return provider(settings.model)
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
        model: createLanguageModel(request.settings, resolvedDependencies)
      })

      for await (const textPart of result.textStream) {
        if (textPart) {
          yield textPart
        }
      }
    }
  }
}
