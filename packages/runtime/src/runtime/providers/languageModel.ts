import type { LanguageModel } from 'ai'

import type { ProviderSettings } from '@yachiyo/shared/protocol'
import type { ModelProcessingTier } from '../models/types.ts'
import type { ResolvedAiSdkRuntimeDependencies } from './dependencies.ts'
import { createAnthropicLanguageModel } from './anthropic.ts'
import { createGatewayDiagnosticFetch, createGatewayLanguageModel } from './gateway.ts'
import { createGoogleLanguageModel } from './google.ts'
import { createOpenAiLanguageModel } from './openai.ts'
import { createVertexLanguageModel } from './vertex.ts'
import {
  resolveMissingCredentialIssue,
  type MissingCredentialIssue
} from './providerCredentials.ts'

const MISSING_CREDENTIAL_MESSAGES: Record<MissingCredentialIssue, string> = {
  'missing-api-key': 'No API key configured. Open Settings and add a provider key first.',
  'missing-codex-session':
    'No Codex session path configured. Open Settings and set the path to your Codex auth.json.',
  'missing-vertex-project':
    'Vertex AI requires a Project ID. Open Settings and configure your Vertex provider.'
}

export function assertConfigured(settings: ProviderSettings): void {
  if (!settings.model.trim()) {
    throw new Error('No model configured. Open Settings and choose a model first.')
  }

  const issue = resolveMissingCredentialIssue(settings)
  if (issue) {
    throw new Error(MISSING_CREDENTIAL_MESSAGES[issue])
  }
}

export interface CreateLanguageModelOptions {
  onReasoningDelta?: (delta: string) => void
  historicalReasoningContents?: string[]
  processingTier?: ModelProcessingTier
  sessionId?: string
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
        processingTier: options.processingTier,
        sessionId: options.sessionId,
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
