import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createVertex } from '@ai-sdk/google-vertex'
import { createGateway, streamText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'

import { sleep } from '../../channels/connectionRetry.ts'

export type OpenAIProviderFactory = typeof createOpenAI
export type AnthropicProviderFactory = typeof createAnthropic
export type GoogleProviderFactory = typeof createGoogleGenerativeAI
export type VertexProviderFactory = typeof createVertex
export type GatewayProviderFactory = typeof createGateway
export type StreamTextImplementation = typeof streamText
export type SleepImplementation = typeof sleep

export interface AiSdkRuntimeDependencies {
  createAnthropicProvider?: AnthropicProviderFactory
  createGatewayProvider?: GatewayProviderFactory
  createGoogleProvider?: GoogleProviderFactory
  createOpenAIProvider?: OpenAIProviderFactory
  createVertexProvider?: VertexProviderFactory
  streamTextImpl?: StreamTextImplementation
  fetchImpl?: typeof globalThis.fetch
  sleepImpl?: SleepImplementation
}

export interface ResolvedAiSdkRuntimeDependencies {
  createAnthropicProvider: AnthropicProviderFactory
  createGatewayProvider: GatewayProviderFactory
  createGoogleProvider: GoogleProviderFactory
  createOpenAIProvider: OpenAIProviderFactory
  createVertexProvider: VertexProviderFactory
  streamTextImpl: StreamTextImplementation
  fetchImpl: typeof globalThis.fetch
  sleepImpl: SleepImplementation
}

export interface FetchModelsDependencies {
  getVertexAdcAccessToken?: () => Promise<string>
}

export function resolveAiSdkRuntimeDependencies(
  dependencies: AiSdkRuntimeDependencies = {}
): ResolvedAiSdkRuntimeDependencies {
  return {
    createAnthropicProvider: dependencies.createAnthropicProvider ?? createAnthropic,
    createGatewayProvider: dependencies.createGatewayProvider ?? createGateway,
    createGoogleProvider: dependencies.createGoogleProvider ?? createGoogleGenerativeAI,
    createOpenAIProvider: dependencies.createOpenAIProvider ?? createOpenAI,
    createVertexProvider: dependencies.createVertexProvider ?? createVertex,
    streamTextImpl: dependencies.streamTextImpl ?? streamText,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    sleepImpl: dependencies.sleepImpl ?? sleep
  }
}
