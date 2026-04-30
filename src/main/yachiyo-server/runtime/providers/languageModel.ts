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

  if (!settings.apiKey.trim() && settings.provider !== 'openai-codex') {
    throw new Error('No API key configured. Open Settings and add a provider key first.')
  }

  if (settings.provider === 'openai-codex' && !settings.codexSessionPath?.trim()) {
    throw new Error(
      'No Codex session path configured. Open Settings and set the path to your Codex auth.json.'
    )
  }
}

export interface CreateLanguageModelOptions {
  onReasoningDelta?: (delta: string) => void
  historicalReasoningContents?: string[]
}

export function createLanguageModel(
  settings: ProviderSettings,
  dependencies: ResolvedAiSdkRuntimeDependencies,
  mode: 'default' | 'auxiliary' = 'default',
  options: CreateLanguageModelOptions = {}
): LanguageModel {
  if (
    settings.provider === 'openai' ||
    settings.provider === 'openai-responses' ||
    settings.provider === 'openai-codex'
  ) {
    return createOpenAiLanguageModel(
      settings,
      dependencies,
      mode,
      createGatewayDiagnosticFetch(settings),
      {
        onReasoningDelta: options.onReasoningDelta,
        ...(settings.provider === 'openai'
          ? { historicalReasoningContents: options.historicalReasoningContents }
          : {})
      }
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
