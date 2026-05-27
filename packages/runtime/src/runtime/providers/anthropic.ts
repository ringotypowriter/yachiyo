import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3ReasoningPart
} from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

import type { ProviderConfig, ProviderSettings } from '@yachiyo/shared/protocol'
import type { ResolvedAiSdkRuntimeDependencies } from './dependencies.ts'
import {
  createDeepSeekV4ProMaxEffortFetch,
  isDeepSeekV4ProMaxEffortModel
} from './deepseekMaxEffort.ts'
import {
  ANTHROPIC_THINKING_BUDGET_BY_EFFORT,
  cleanBaseUrl,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS,
  type RuntimeProviderOptions
} from './shared.ts'

type AnthropicRequestMessage = {
  role?: string
  content?: unknown
}

type AnthropicThinkingBlock = {
  type: 'thinking'
  thinking: string
}

function readBodyText(body: BodyInit | null | undefined): string | undefined {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function readAnthropicOptions(part: { providerOptions?: unknown }): Record<string, unknown> {
  const providerOptions = part.providerOptions
  if (!isRecord(providerOptions)) return {}
  const anthropicOptions = providerOptions['anthropic']
  return isRecord(anthropicOptions) ? anthropicOptions : {}
}

function hasOtherProviderOptions(part: { providerOptions?: unknown }): boolean {
  const providerOptions = part.providerOptions
  if (!isRecord(providerOptions)) return false
  return Object.entries(providerOptions).some(
    ([provider, value]) =>
      provider !== 'anthropic' &&
      value != null &&
      typeof value === 'object' &&
      Object.keys(value).length > 0
  )
}

function isReplayableUnsignedReasoningPart(part: unknown): part is LanguageModelV3ReasoningPart {
  if (!isRecord(part) || part['type'] !== 'reasoning' || typeof part['text'] !== 'string') {
    return false
  }
  if (part['text'].length === 0) return false
  if (hasOtherProviderOptions(part)) return false

  const anthropicOptions = readAnthropicOptions(part)
  return anthropicOptions['signature'] == null && anthropicOptions['redactedData'] == null
}

function consumesAnthropicBodyPart(part: unknown): boolean {
  if (!isRecord(part) || part['type'] !== 'reasoning') return true

  const anthropicOptions = readAnthropicOptions(part)
  return anthropicOptions['signature'] != null || anthropicOptions['redactedData'] != null
}

function toThinkingBlock(part: LanguageModelV3ReasoningPart): AnthropicThinkingBlock {
  return {
    type: 'thinking',
    thinking: part.text
  }
}

function injectThinkingBlocksIntoAssistantContent(
  promptContent: LanguageModelV3Message['content'],
  bodyContent: unknown
): unknown {
  if (!Array.isArray(promptContent) || !Array.isArray(bodyContent)) return bodyContent
  if (!promptContent.some(isReplayableUnsignedReasoningPart)) return bodyContent

  const result: unknown[] = []
  let bodyIndex = 0
  for (const promptPart of promptContent) {
    if (isReplayableUnsignedReasoningPart(promptPart)) {
      result.push(toThinkingBlock(promptPart))
      continue
    }

    if (consumesAnthropicBodyPart(promptPart) && bodyIndex < bodyContent.length) {
      result.push(bodyContent[bodyIndex])
      bodyIndex++
    }
  }

  if (bodyIndex < bodyContent.length) {
    result.push(...bodyContent.slice(bodyIndex))
  }

  return result
}

export function shouldReplayUnsignedAnthropicThinking(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.hostname !== 'api.anthropic.com'
  } catch {
    return false
  }
}

export function injectUnsignedThinkingIntoAnthropicBody(
  bodyText: string,
  prompt: LanguageModelV3CallOptions['prompt']
): string {
  const parsed = JSON.parse(bodyText) as { messages?: AnthropicRequestMessage[] }
  if (!Array.isArray(parsed.messages)) return bodyText

  const assistantPrompts = prompt.filter((message) => message.role === 'assistant')
  if (assistantPrompts.length === 0) return bodyText

  let assistantIndex = 0
  let modified = false
  const messages = parsed.messages.map((message) => {
    if (message.role !== 'assistant') return message

    const promptMessage = assistantPrompts[assistantIndex]
    assistantIndex++
    if (!promptMessage) return message

    const content = injectThinkingBlocksIntoAssistantContent(promptMessage.content, message.content)
    if (content === message.content) return message

    modified = true
    return { ...message, content }
  })

  return modified ? JSON.stringify({ ...parsed, messages }) : bodyText
}

function createUnsignedThinkingReplayFetch(
  fetchImpl: typeof globalThis.fetch,
  getPrompt: () => LanguageModelV3CallOptions['prompt'] | undefined
): typeof globalThis.fetch {
  return async (input, init) => {
    const prompt = getPrompt()
    const bodyText = readBodyText(init?.body)
    if (!prompt || !bodyText) {
      return fetchImpl(input, init)
    }

    const nextBody = injectUnsignedThinkingIntoAnthropicBody(bodyText, prompt)
    return fetchImpl(input, nextBody === bodyText ? init : { ...init, body: nextBody })
  }
}

function withPrompt<T>(
  promptStack: LanguageModelV3CallOptions['prompt'][],
  prompt: LanguageModelV3CallOptions['prompt'],
  run: () => PromiseLike<T>
): PromiseLike<T> {
  promptStack.push(prompt)
  return Promise.resolve(run()).finally(() => {
    promptStack.pop()
  })
}

function wrapUnsignedThinkingReplayModel(
  model: LanguageModelV3,
  promptStack: LanguageModelV3CallOptions['prompt'][]
): LanguageModelV3 {
  return {
    specificationVersion: model.specificationVersion,
    get provider() {
      return model.provider
    },
    get modelId() {
      return model.modelId
    },
    get supportedUrls() {
      return model.supportedUrls
    },
    doGenerate: (options) =>
      withPrompt(promptStack, options.prompt, () => model.doGenerate(options)),
    doStream: (options) => withPrompt(promptStack, options.prompt, () => model.doStream(options))
  }
}

export function createAnthropicLanguageModel(
  settings: ProviderSettings,
  dependencies: ResolvedAiSdkRuntimeDependencies
): LanguageModel {
  const baseURL = cleanBaseUrl(settings.baseUrl, DEFAULT_ANTHROPIC_BASE_URL)
  const shouldReplayUnsignedThinking = shouldReplayUnsignedAnthropicThinking(baseURL)
  const promptStack: LanguageModelV3CallOptions['prompt'][] = []
  const maxEffortFetch =
    settings.thinkingEnabled !== false && isDeepSeekV4ProMaxEffortModel(settings.model)
      ? createDeepSeekV4ProMaxEffortFetch(
          {
            provider: 'anthropic',
            model: settings.model,
            thinkingEnabled: settings.thinkingEnabled,
            reasoningEffort: settings.reasoningEffort
          },
          dependencies.fetchImpl
        )
      : undefined
  const fetchImpl = maxEffortFetch ?? dependencies.fetchImpl
  const unsignedThinkingReplayFetch = shouldReplayUnsignedThinking
    ? createUnsignedThinkingReplayFetch(fetchImpl, () => promptStack.at(-1))
    : undefined
  const provider = dependencies.createAnthropicProvider({
    apiKey: settings.apiKey,
    baseURL,
    ...(unsignedThinkingReplayFetch || maxEffortFetch
      ? { fetch: unsignedThinkingReplayFetch ?? maxEffortFetch }
      : {})
  })

  const model = provider(settings.model)
  return shouldReplayUnsignedThinking
    ? (wrapUnsignedThinkingReplayModel(model as LanguageModelV3, promptStack) as LanguageModel)
    : model
}

export function createAnthropicProviderOptions(
  settings: ProviderSettings,
  mode: 'default' | 'auxiliary'
): RuntimeProviderOptions {
  return {
    anthropic: {
      thinking: {
        ...(mode === 'auxiliary' ||
        settings.thinkingEnabled === false ||
        settings.reasoningEffort === 'off'
          ? { type: 'disabled' as const }
          : {
              type: 'enabled' as const,
              budgetTokens: settings.reasoningEffort
                ? ANTHROPIC_THINKING_BUDGET_BY_EFFORT[settings.reasoningEffort]
                : DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS
            })
      }
    }
  }
}

export async function fetchAnthropicModels(
  provider: ProviderConfig,
  fetchImpl: typeof globalThis.fetch
): Promise<string[]> {
  const baseUrl = cleanBaseUrl(provider.baseUrl, DEFAULT_ANTHROPIC_BASE_URL)
  const url = `${baseUrl}/models?limit=100`
  console.log('[fetchModels] fetching anthropic:', url)
  const response = await fetchImpl(url, {
    headers: {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01'
    }
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const body = (await response.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((model) => model.id).sort()
}
