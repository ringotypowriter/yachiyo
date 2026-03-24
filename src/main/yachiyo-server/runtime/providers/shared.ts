export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const DEFAULT_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v3/ai'
export const DEFAULT_OPENAI_REASONING_EFFORT = 'medium'
export const DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS = 1024
export const DEFAULT_GEMINI_THINKING_BUDGET = 1024
export const DEFAULT_VERCEL_GATEWAY_THINKING_LEVEL = 'medium'

export type OpenAiChatRuntimeProviderOptions = {
  openai: {
    store: false
  }
}

export type OpenAiResponsesRuntimeProviderOptions = {
  openai: {
    reasoningEffort?: string
    store: false
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
      includeThoughts: true
    }
  }
}

export type VertexRuntimeProviderOptions = {
  vertex: {
    thinkingConfig?: {
      thinkingBudget: number
      includeThoughts: true
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
      includeThoughts: true
      thinkingLevel: 'medium'
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
