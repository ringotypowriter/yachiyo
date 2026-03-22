import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { stepCountIs, streamText, type LanguageModel } from 'ai'

import type { ProviderConfig, ProviderSettings } from '../../../shared/yachiyo/protocol'
import { prepareAiSdkMessages } from './messagePrepare.ts'
import type { ModelProviderOptionsMode, ModelRuntime } from './types.ts'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const DEFAULT_OPENAI_REASONING_EFFORT = 'medium'
const DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS = 1024

type OpenAIProviderFactory = typeof createOpenAI
type AnthropicProviderFactory = typeof createAnthropic
type StreamTextImplementation = typeof streamText

type OpenAiRuntimeProviderOptions = {
  openai: {
    reasoningEffort?: string
    store: false
  }
}

type AnthropicRuntimeProviderOptions = {
  anthropic: {
    thinking: {
      type: 'enabled' | 'disabled'
      budgetTokens?: number
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
  dependencies: Required<AiSdkRuntimeDependencies>,
  mode: ModelProviderOptionsMode = 'default'
): LanguageModel {
  if (settings.provider === 'openai') {
    const provider = dependencies.createOpenAIProvider({
      apiKey: settings.apiKey,
      baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_OPENAI_BASE_URL)
    })
    return mode === 'auxiliary' ? provider.chat(settings.model) : provider.responses(settings.model)
  }

  const provider = dependencies.createAnthropicProvider({
    apiKey: settings.apiKey,
    baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_ANTHROPIC_BASE_URL)
  })
  return provider(settings.model)
}

function createProviderOptions(
  settings: ProviderSettings,
  mode: ModelProviderOptionsMode = 'default'
): RuntimeProviderOptions {
  if (settings.provider === 'openai') {
    const reasoningEffort =
      mode === 'default' && supportsOpenAIReasoningEffort(settings.model)
        ? DEFAULT_OPENAI_REASONING_EFFORT
        : undefined

    return {
      openai: {
        // Keep tool-call context inline for proxy compatibility instead of
        // depending on provider-side item storage across tool steps.
        ...(reasoningEffort ? { reasoningEffort } : {}),
        store: false
      }
    }
  }

  return {
    anthropic: {
      thinking: {
        ...(mode === 'auxiliary'
          ? { type: 'disabled' as const }
          : {
              type: 'enabled' as const,
              budgetTokens: DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS
            })
      }
    }
  }
}

function supportsOpenAIReasoningEffort(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()

  return (
    normalized.startsWith('gpt-5') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  )
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

      const finishedToolCallIds = new Set<string>()
      const toolCallContextById = new Map<string, { input: unknown; toolName: string }>()
      const toolCallFinishCallback = request.onToolCallFinish
      const emitToolCallFinish = toolCallFinishCallback
        ? (event: Parameters<NonNullable<typeof toolCallFinishCallback>>[0]) => {
            const toolCallId = event.toolCall.toolCallId
            if (finishedToolCallIds.has(toolCallId)) {
              return
            }

            finishedToolCallIds.add(toolCallId)

            try {
              return toolCallFinishCallback(event)
            } catch (error) {
              finishedToolCallIds.delete(toolCallId)
              throw error
            }
          }
        : undefined

      const result = resolvedDependencies.streamTextImpl({
        abortSignal: request.signal,
        messages: prepareAiSdkMessages(request.messages),
        model: createLanguageModel(
          request.settings,
          resolvedDependencies,
          request.providerOptionsMode ?? 'default'
        ),
        providerOptions: createProviderOptions(
          request.settings,
          request.providerOptionsMode ?? 'default'
        ),
        ...(request.tools ? { tools: request.tools, stopWhen: stepCountIs(20) } : {}),
        ...(request.onToolCallStart
          ? { experimental_onToolCallStart: request.onToolCallStart }
          : {}),
        ...(emitToolCallFinish ? { experimental_onToolCallFinish: emitToolCallFinish } : {})
      })

      if ('fullStream' in result && result.fullStream) {
        for await (const part of result.fullStream as AsyncIterable<{
          errorText?: string
          input?: unknown
          inputTextDelta?: string
          output?: unknown
          error?: unknown
          preliminary?: boolean
          text?: string
          toolCallId?: string
          toolName?: string
          type: string
        }>) {
          if (part.type === 'text-delta' && part.text) {
            yield part.text
            continue
          }

          if (
            part.type === 'tool-input-available' &&
            typeof part.toolCallId === 'string' &&
            typeof part.toolName === 'string'
          ) {
            toolCallContextById.set(part.toolCallId, {
              input: part.input,
              toolName: part.toolName
            })
            continue
          }

          if (part.type === 'tool-input-error' && typeof part.toolCallId === 'string') {
            toolCallContextById.delete(part.toolCallId)
            continue
          }

          if (
            (part.type === 'tool-output-available' || part.type === 'tool-result') &&
            part.preliminary === true &&
            request.onToolCallUpdate &&
            typeof part.toolCallId === 'string'
          ) {
            const toolCallContext =
              (typeof part.toolName === 'string'
                ? { input: part.input, toolName: part.toolName }
                : undefined) ?? toolCallContextById.get(part.toolCallId)

            if (!toolCallContext) {
              continue
            }

            request.onToolCallUpdate({
              output: part.output,
              toolCall: {
                input: toolCallContext.input,
                toolCallId: part.toolCallId,
                toolName: toolCallContext.toolName
              }
            })
            continue
          }

          if (
            (part.type === 'tool-output-available' || part.type === 'tool-result') &&
            part.preliminary !== true &&
            emitToolCallFinish &&
            typeof part.toolCallId === 'string'
          ) {
            const toolCallContext =
              (typeof part.toolName === 'string'
                ? { input: part.input, toolName: part.toolName }
                : undefined) ?? toolCallContextById.get(part.toolCallId)

            if (!toolCallContext) {
              continue
            }

            emitToolCallFinish({
              abortSignal: request.signal,
              durationMs: 0,
              experimental_context: undefined,
              functionId: undefined,
              metadata: undefined,
              model: undefined,
              messages: request.messages,
              stepNumber: undefined,
              success: true,
              output: part.output,
              toolCall: {
                type: 'tool-call',
                dynamic: true,
                toolCallId: part.toolCallId,
                toolName: toolCallContext.toolName,
                input: toolCallContext.input
              }
            })
            toolCallContextById.delete(part.toolCallId)
            continue
          }

          if (
            (part.type === 'tool-output-error' || part.type === 'tool-error') &&
            emitToolCallFinish &&
            typeof part.toolCallId === 'string'
          ) {
            const toolCallContext =
              (typeof part.toolName === 'string'
                ? { input: part.input, toolName: part.toolName }
                : undefined) ?? toolCallContextById.get(part.toolCallId)

            if (!toolCallContext) {
              continue
            }

            emitToolCallFinish({
              abortSignal: request.signal,
              durationMs: 0,
              experimental_context: undefined,
              functionId: undefined,
              metadata: undefined,
              model: undefined,
              messages: request.messages,
              stepNumber: undefined,
              success: false,
              error: part.error ?? part.errorText,
              toolCall: {
                type: 'tool-call',
                dynamic: true,
                toolCallId: part.toolCallId,
                toolName: toolCallContext.toolName,
                input: toolCallContext.input
              }
            })
            toolCallContextById.delete(part.toolCallId)
          }
        }

        return
      }

      for await (const textPart of result.textStream) {
        if (textPart) {
          yield textPart
        }
      }
    }
  }
}
