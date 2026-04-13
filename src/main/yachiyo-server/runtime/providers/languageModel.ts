import type { LanguageModel } from 'ai'

import type { ProviderSettings } from '../../../../shared/yachiyo/protocol'
import type { ResolvedAiSdkRuntimeDependencies } from './dependencies.ts'
import { createAnthropicLanguageModel } from './anthropic.ts'
import { createGatewayDiagnosticFetch, createGatewayLanguageModel } from './gateway.ts'
import { createGoogleLanguageModel } from './google.ts'
import { createOpenAiLanguageModel } from './openai.ts'
import { createVertexLanguageModel } from './vertex.ts'

export function assertConfigured(settings: ProviderSettings): void {
  if (!settings.model.trim()) {
    throw new Error('No model configured. Open Settings and choose a model first.')
  }

  if (settings.provider === 'vertex') {
    if (!settings.project?.trim()) {
      throw new Error(
        'Vertex AI requires a Project ID. Open Settings and configure your Vertex provider.'
      )
    }
    return
  }

  if (!settings.apiKey.trim()) {
    throw new Error('No API key configured. Open Settings and add a provider key first.')
  }
}

export interface CreateLanguageModelOptions {
  onReasoningDelta?: (delta: string) => void
}

export function createLanguageModel(
  settings: ProviderSettings,
  dependencies: ResolvedAiSdkRuntimeDependencies,
  mode: 'default' | 'auxiliary' = 'default',
  options: CreateLanguageModelOptions = {}
): LanguageModel {
  if (settings.provider === 'openai' || settings.provider === 'openai-responses') {
    return createOpenAiLanguageModel(
      settings,
      dependencies,
      mode,
      createGatewayDiagnosticFetch(settings),
      { onReasoningDelta: options.onReasoningDelta }
    )
  }

  if (settings.provider === 'gemini') {
    return createGoogleLanguageModel(settings, dependencies)
  }

  if (settings.provider === 'vertex') {
    return createVertexLanguageModel(settings, dependencies, dependencies.fetchImpl)
  }

  if (settings.provider === 'vercel-gateway') {
    return createGatewayLanguageModel(
      settings,
      dependencies,
      createGatewayDiagnosticFetch(settings)
    )
  }

  return createAnthropicLanguageModel(settings, dependencies)
}
