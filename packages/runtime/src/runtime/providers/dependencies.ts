import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createVertex } from '@ai-sdk/google-vertex'
import { createGateway, streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

import type { ResponsesWebSocketSupportStore } from './responsesWebSocketSupport.ts'

import { sleep } from '../../channels/shared/connectionRetry.ts'

export type OpenAIProviderFactory = typeof createOpenAI
export type AnthropicProviderFactory = typeof createAnthropic
export type GoogleProviderFactory = typeof createGoogle
export type VertexProviderFactory = typeof createVertex
export type GatewayProviderFactory = typeof createGateway
export type StreamTextImplementation = typeof streamText
export type SleepImplementation = typeof sleep
export type NowImplementation = () => number

export interface AiSdkRuntimeDependencies {
  responsesWebSocketSupport?: ResponsesWebSocketSupportStore
  createAnthropicProvider?: AnthropicProviderFactory
  createGatewayProvider?: GatewayProviderFactory
  createGoogleProvider?: GoogleProviderFactory
  createOpenAIProvider?: OpenAIProviderFactory
  createVertexProvider?: VertexProviderFactory
  streamTextImpl?: StreamTextImplementation
  fetchImpl?: typeof globalThis.fetch
  sleepImpl?: SleepImplementation
  nowImpl?: NowImplementation
}

export interface ResolvedAiSdkRuntimeDependencies {
  responsesWebSocketSupport?: ResponsesWebSocketSupportStore
  createAnthropicProvider: AnthropicProviderFactory
  createGatewayProvider: GatewayProviderFactory
  createGoogleProvider: GoogleProviderFactory
  createOpenAIProvider: OpenAIProviderFactory
  createVertexProvider: VertexProviderFactory
  streamTextImpl: StreamTextImplementation
  fetchImpl: typeof globalThis.fetch
  sleepImpl: SleepImplementation
  nowImpl: NowImplementation
}

export interface FetchModelsDependencies {
  getVertexAdcAccessToken?: () => Promise<string>
}

export function resolveAiSdkRuntimeDependencies(
  dependencies: AiSdkRuntimeDependencies = {}
): ResolvedAiSdkRuntimeDependencies {
  return {
    responsesWebSocketSupport: dependencies.responsesWebSocketSupport,
    createAnthropicProvider: dependencies.createAnthropicProvider ?? createAnthropic,
    createGatewayProvider: dependencies.createGatewayProvider ?? createGateway,
    createGoogleProvider: dependencies.createGoogleProvider ?? createGoogle,
    createOpenAIProvider: dependencies.createOpenAIProvider ?? createOpenAI,
    createVertexProvider: dependencies.createVertexProvider ?? createVertex,
    streamTextImpl: dependencies.streamTextImpl ?? streamText,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    sleepImpl: dependencies.sleepImpl ?? sleep,
    nowImpl: dependencies.nowImpl ?? (() => performance.now())
  }
}
