import type { ReasoningEffortLevel } from '../../../../shared/yachiyo/protocol.ts'

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const DEFAULT_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v3/ai'
export const DEFAULT_OPENAI_REASONING_EFFORT = 'medium'
export const DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS = 8000
export const DEFAULT_GEMINI_THINKING_BUDGET = 1024
export const DEFAULT_VERCEL_GATEWAY_THINKING_LEVEL = 'medium'

export const ANTHROPIC_THINKING_BUDGET_BY_EFFORT: Record<ReasoningEffortLevel, number> = {
  low: 4000,
  medium: DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS,
  high: 16000,
  xhigh: 32000,
  max: 64000
}

export const GEMINI_THINKING_BUDGET_BY_EFFORT: Record<ReasoningEffortLevel, number> = {
  low: 512,
  medium: DEFAULT_GEMINI_THINKING_BUDGET,
  high: 4096,
  xhigh: 8192,
  max: 24576
}

export const OPENAI_COMPAT_THINKING_BUDGET_BY_EFFORT: Record<ReasoningEffortLevel, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768
}

export const KIMI_THINKING_BUDGET_BY_EFFORT: Record<ReasoningEffortLevel, number> = {
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536
}

/**
 * Hosts whose APIs count thinking tokens inside `maxOutputTokens`.
 * When a provider matches, the runtime inflates the cap by the thinking budget
 * so the user's visible-output limit is preserved.
 *
 * Add new hosts here when onboarding providers with the same behaviour.
 */
export const THINKING_INSIDE_MAX_OUTPUT_HOSTS: readonly string[] = ['api.kimi.com']

export type OpenAiChatRuntimeProviderOptions = {
  openai: {
    store: false
    promptCacheKey?: string
    textVerbosity?: 'low' | 'medium' | 'high'
  }
}

export type OpenAiResponsesRuntimeProviderOptions = {
  openai: {
    reasoningEffort?: string
    reasoningSummary?: 'auto' | 'detailed'
    store: false
    promptCacheKey?: string
    textVerbosity?: 'low' | 'medium' | 'high'
    instructions?: string
  }
}

export type AnthropicRuntimeProviderOptions = {
  anthropic: {
    thinking: {
      type: 'enabled' | 'disabled'
      budgetTokens?: number
    }
  }
}

export type GeminiRuntimeProviderOptions = {
  google: {
    thinkingConfig?: {
      thinkingBudget: number
      includeThoughts: boolean
    }
  }
}

export type VertexRuntimeProviderOptions = {
  vertex: {
    thinkingConfig?: {
      thinkingBudget: number
      includeThoughts: boolean
    }
  }
}

export type VercelGatewayRuntimeProviderOptions = {
  gateway: {
    order: ['vertex']
  }
}

export type VercelGatewayThinkingRuntimeProviderOptions = VercelGatewayRuntimeProviderOptions & {
  vertex: {
    thinkingConfig: {
      includeThoughts: boolean
      thinkingLevel: 'low' | 'medium' | 'high'
    }
  }
}

export type RuntimeProviderOptions =
  | OpenAiChatRuntimeProviderOptions
  | OpenAiResponsesRuntimeProviderOptions
  | AnthropicRuntimeProviderOptions
  | GeminiRuntimeProviderOptions
  | VertexRuntimeProviderOptions
  | VercelGatewayRuntimeProviderOptions
  | VercelGatewayThinkingRuntimeProviderOptions
  | Record<string, never>

export interface ModelsResponseItem {
  id: string
}

export interface GeminiModelsResponseItem {
  name: string
}

export interface VertexPublisherModel {
  name: string
}

export function cleanBaseUrl(baseUrl: string, fallback: string): string {
  return (baseUrl.trim() || fallback).replace(/\/+$/, '')
}
