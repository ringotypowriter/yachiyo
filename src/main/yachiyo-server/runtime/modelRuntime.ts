import { createSign } from 'node:crypto'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createVertex } from '@ai-sdk/google-vertex'
import { createGateway, stepCountIs, streamText, type LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { GoogleAuth } from 'google-auth-library'

import type { ProviderConfig, ProviderSettings } from '../../../shared/yachiyo/protocol'
import { prepareAiSdkMessages } from './messagePrepare.ts'
import type { ModelProviderOptionsMode, ModelRuntime } from './types.ts'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v3/ai'
const DEFAULT_OPENAI_REASONING_EFFORT = 'medium'
const DEFAULT_ANTHROPIC_THINKING_BUDGET_TOKENS = 1024
const DEFAULT_GEMINI_THINKING_BUDGET = 1024
const DEFAULT_VERCEL_GATEWAY_THINKING_LEVEL = 'medium'
const DEFAULT_MAX_RETRIES = 3

type OpenAIProviderFactory = typeof createOpenAI
type AnthropicProviderFactory = typeof createAnthropic
type GoogleProviderFactory = typeof createGoogleGenerativeAI
type VertexProviderFactory = typeof createVertex
type GatewayProviderFactory = typeof createGateway
type StreamTextImplementation = typeof streamText

type OpenAiChatRuntimeProviderOptions = {
  openai: {
    store: false
  }
}

type OpenAiResponsesRuntimeProviderOptions = {
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

type GeminiRuntimeProviderOptions = {
  google: {
    thinkingConfig?: {
      thinkingBudget: number
      includeThoughts: true
    }
  }
}

type VertexRuntimeProviderOptions = {
  vertex: {
    thinkingConfig?: {
      thinkingBudget: number
      includeThoughts: true
    }
  }
}

type VercelGatewayRuntimeProviderOptions = {
  gateway: {
    order: ['vertex']
  }
}

type VercelGatewayThinkingRuntimeProviderOptions = VercelGatewayRuntimeProviderOptions & {
  vertex: {
    thinkingConfig: {
      includeThoughts: true
      thinkingLevel: 'medium'
    }
  }
}

type RuntimeProviderOptions =
  | OpenAiChatRuntimeProviderOptions
  | OpenAiResponsesRuntimeProviderOptions
  | AnthropicRuntimeProviderOptions
  | GeminiRuntimeProviderOptions
  | VertexRuntimeProviderOptions
  | VercelGatewayRuntimeProviderOptions
  | VercelGatewayThinkingRuntimeProviderOptions
  | Record<string, never>

export interface AiSdkRuntimeDependencies {
  createAnthropicProvider?: AnthropicProviderFactory
  createGatewayProvider?: GatewayProviderFactory
  createGoogleProvider?: GoogleProviderFactory
  createOpenAIProvider?: OpenAIProviderFactory
  createVertexProvider?: VertexProviderFactory
  streamTextImpl?: StreamTextImplementation
  fetchImpl?: typeof globalThis.fetch
}

function cleanBaseUrl(baseUrl: string, fallback: string): string {
  return (baseUrl.trim() || fallback).replace(/\/+$/, '')
}

function assertConfigured(settings: ProviderSettings): void {
  if (!settings.model.trim()) {
    throw new Error('No model configured. Open Settings and choose a model first.')
  }

  if (settings.provider === 'vertex') {
    // True Vertex AI uses project + location; auth via service account or ADC — no API key needed.
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

function isVercelGatewayBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'ai-gateway.vercel.sh'
  } catch {
    return baseUrl.includes('ai-gateway.vercel.sh')
  }
}

function normalizeGatewayBaseUrl(baseUrl: string): string {
  const normalized = cleanBaseUrl(baseUrl, DEFAULT_GATEWAY_BASE_URL)

  if (!isVercelGatewayBaseUrl(normalized)) {
    return normalized
  }

  try {
    const url = new URL(normalized)
    const path = url.pathname.replace(/\/+$/, '')

    if (path === '' || path === '/' || path === '/v1' || path === '/v1/ai' || path === '/v3') {
      url.pathname = '/v3/ai'
      return url.toString().replace(/\/+$/, '')
    }
  } catch {
    return normalized
  }

  return normalized
}

function shouldLogGatewayDiagnostics(settings: ProviderSettings): boolean {
  if (settings.provider !== 'openai' && settings.provider !== 'vercel-gateway') {
    return false
  }

  const normalizedModel = settings.model.trim().toLowerCase()
  const normalizedBaseUrl =
    settings.provider === 'vercel-gateway'
      ? normalizeGatewayBaseUrl(settings.baseUrl)
      : cleanBaseUrl(settings.baseUrl, DEFAULT_OPENAI_BASE_URL)

  return normalizedModel.startsWith('google/gemini') && isVercelGatewayBaseUrl(normalizedBaseUrl)
}

function toSerializableError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: error }
  }

  const ownProperties = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((key) => [
      key,
      (error as unknown as Record<string, unknown>)[key]
    ])
  )

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...ownProperties
  }
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>()

  try {
    return JSON.stringify(
      value,
      (_key, currentValue) => {
        if (typeof currentValue === 'bigint') {
          return currentValue.toString()
        }

        if (currentValue instanceof Error) {
          return toSerializableError(currentValue)
        }

        if (typeof currentValue === 'object' && currentValue !== null) {
          if (seen.has(currentValue)) {
            return '[Circular]'
          }

          seen.add(currentValue)
        }

        return currentValue
      },
      2
    )
  } catch (error) {
    return JSON.stringify({
      fallback: 'Failed to serialize diagnostic payload.',
      error: toSerializableError(error),
      valueType: typeof value
    })
  }
}

function logGatewayDiagnostics(label: string, payload: unknown): void {
  console.debug(`[gateway-diagnostic] ${label}\n${safeJsonStringify(payload)}`)
}

function createGatewayDiagnosticFetch(
  settings: ProviderSettings
): typeof globalThis.fetch | undefined {
  if (!shouldLogGatewayDiagnostics(settings)) {
    return undefined
  }

  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    logGatewayDiagnostics('request', {
      method: init?.method ?? 'GET',
      model: settings.model,
      url
    })

    const response = await fetch(input, init)

    if (!response.ok) {
      let responseBody: string | null = null

      try {
        responseBody = await response.clone().text()
      } catch (error) {
        responseBody = safeJsonStringify({
          error: toSerializableError(error),
          message: 'Failed to read error response body.'
        })
      }

      logGatewayDiagnostics('response-error', {
        headers: Object.fromEntries(response.headers.entries()),
        model: settings.model,
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
        url
      })
    }

    return response
  }
}

function createLanguageModel(
  settings: ProviderSettings,
  dependencies: Required<AiSdkRuntimeDependencies>,
  mode: ModelProviderOptionsMode = 'default',
  fetchImpl?: typeof globalThis.fetch
): LanguageModel {
  if (shouldUseOpenAIResponsesApi(settings)) {
    const diagnosticFetch = createGatewayDiagnosticFetch(settings)
    const provider = dependencies.createOpenAIProvider({
      apiKey: settings.apiKey,
      baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_OPENAI_BASE_URL),
      ...(diagnosticFetch ? { fetch: diagnosticFetch } : {})
    })
    return mode === 'auxiliary' ? provider.chat(settings.model) : provider.responses(settings.model)
  }

  if (settings.provider === 'openai') {
    const provider = dependencies.createOpenAIProvider({
      apiKey: settings.apiKey,
      baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_OPENAI_BASE_URL)
    })
    return provider.chat(settings.model)
  }

  if (settings.provider === 'openai-responses') {
    const diagnosticFetch = createGatewayDiagnosticFetch(settings)
    const provider = dependencies.createOpenAIProvider({
      apiKey: settings.apiKey,
      baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_OPENAI_BASE_URL),
      ...(diagnosticFetch ? { fetch: diagnosticFetch } : {})
    })
    return mode === 'auxiliary' ? provider.chat(settings.model) : provider.responses(settings.model)
  }

  if (settings.provider === 'gemini') {
    const provider = dependencies.createGoogleProvider({
      apiKey: settings.apiKey,
      baseURL: cleanBaseUrl(settings.baseUrl, DEFAULT_GEMINI_BASE_URL)
    })
    return provider(settings.model)
  }

  if (settings.provider === 'vertex') {
    const project = settings.project ?? ''
    const location = settings.location ?? 'us-central1'
    const hasServiceAccount =
      !!settings.serviceAccountEmail?.trim() && !!settings.serviceAccountPrivateKey?.trim()

    // baseURL is calculated by the SDK from project + location.
    // Falls back to {location}-aiplatform.googleapis.com when not provided.
    const provider = dependencies.createVertexProvider({
      project,
      location,
      ...(hasServiceAccount
        ? {
            googleAuthOptions: {
              credentials: {
                client_email: settings.serviceAccountEmail!,
                private_key: settings.serviceAccountPrivateKey!
              }
            }
          }
        : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {})
    })
    return provider(settings.model)
  }

  if (settings.provider === 'vercel-gateway') {
    const diagnosticFetch = createGatewayDiagnosticFetch(settings)
    const provider = dependencies.createGatewayProvider({
      apiKey: settings.apiKey,
      baseURL: normalizeGatewayBaseUrl(settings.baseUrl),
      ...(diagnosticFetch ? { fetch: diagnosticFetch } : {})
    })
    return provider(settings.model)
  }

  // anthropic
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
  if (settings.provider === 'openai' || settings.provider === 'openai-responses') {
    const reasoningEffort =
      mode === 'default' && supportsOpenAIReasoningEffort(settings.model)
        ? DEFAULT_OPENAI_REASONING_EFFORT
        : undefined

    return {
      openai: {
        ...(reasoningEffort ? { reasoningEffort } : {}),
        // Keep tool-call context inline for proxy compatibility instead of
        // depending on provider-side item storage across tool steps.
        store: false
      }
    }
  }

  if (settings.provider === 'gemini') {
    return supportsGeminiThinking(settings.model)
      ? {
          google: {
            thinkingConfig: {
              thinkingBudget: DEFAULT_GEMINI_THINKING_BUDGET,
              includeThoughts: true
            }
          }
        }
      : { google: {} }
  }

  if (settings.provider === 'vertex') {
    return supportsGeminiThinking(settings.model)
      ? {
          vertex: {
            thinkingConfig: {
              thinkingBudget: DEFAULT_GEMINI_THINKING_BUDGET,
              includeThoughts: true
            }
          }
        }
      : { vertex: {} }
  }

  if (settings.provider === 'vercel-gateway') {
    if (!isVercelGatewayGoogleModel(settings.model)) {
      return {}
    }
    return supportsVercelGatewayThinkingLevel(settings.model)
      ? {
          gateway: {
            order: ['vertex']
          },
          vertex: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: DEFAULT_VERCEL_GATEWAY_THINKING_LEVEL
            }
          }
        }
      : {
          gateway: {
            order: ['vertex']
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

function shouldUseOpenAIResponsesApi(settings: ProviderSettings): boolean {
  return (
    settings.provider === 'openai-responses' ||
    (settings.provider === 'openai' && supportsOpenAIReasoningEffort(settings.model))
  )
}

// Gemini 2.5+ supports extended thinking (budget-based)
function supportsGeminiThinking(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()

  return (
    normalized.startsWith('gemini-2.5') ||
    normalized.startsWith('gemini-3') ||
    normalized.startsWith('gemini-3.') ||
    // Vertex AI style: publishers/google/models/gemini-2.5-...
    normalized.includes('gemini-2.5') ||
    normalized.includes('gemini-3')
  )
}

// Vercel Gateway routes Google models through Vertex; non-google models skip vertex routing.
function isVercelGatewayGoogleModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith('google/')
}

// Vercel Gateway Vertex routing uses thinkingLevel (not thinkingBudget)
function supportsVercelGatewayThinkingLevel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()

  return normalized.startsWith('google/gemini-3') || normalized.startsWith('google/gemini-3.1')
}

interface ModelsResponseItem {
  id: string
}

interface GeminiModelsResponseItem {
  name: string
}

interface VertexPublisherModel {
  name: string
}

// Signs a Google service account JWT and exchanges it for an OAuth2 access token.
async function getVertexServiceAccountToken(
  clientEmail: string,
  privateKey: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claims = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    })
  ).toString('base64url')

  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${claims}`)
  const signature = sign.sign(privateKey).toString('base64url')
  const jwt = `${header}.${claims}.${signature}`

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Failed to obtain Vertex access token: ${response.status} ${body}`)
  }

  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) {
    throw new Error('Vertex token response did not include an access_token.')
  }
  return body.access_token
}

async function getVertexAdcAccessToken(): Promise<string> {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  })
  const accessToken = await auth.getAccessToken()

  if (!accessToken) {
    throw new Error('Failed to obtain Vertex access token from Application Default Credentials.')
  }

  return accessToken
}

interface FetchModelsDependencies {
  getVertexAdcAccessToken?: () => Promise<string>
}

export async function fetchModels(
  provider: ProviderConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  dependencies: FetchModelsDependencies = {}
): Promise<string[]> {
  if (!provider.apiKey.trim() && provider.type !== 'vertex') {
    throw new Error('API key is required')
  }

  if (provider.type === 'anthropic') {
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
    const body = (await response.json()) as { data: ModelsResponseItem[] }
    return (body.data ?? []).map((m) => m.id).sort()
  }

  if (provider.type === 'gemini') {
    const baseUrl = cleanBaseUrl(provider.baseUrl, DEFAULT_GEMINI_BASE_URL)
    const url = `${baseUrl}/models?key=${encodeURIComponent(provider.apiKey)}&pageSize=100`
    console.log('[fetchModels] fetching gemini:', url)
    const response = await fetchImpl(url)
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    const body = (await response.json()) as { models: GeminiModelsResponseItem[] }
    return (body.models ?? [])
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((id) => id.startsWith('gemini'))
      .sort()
  }

  if (provider.type === 'vertex') {
    if (!provider.project?.trim()) {
      throw new Error('Vertex AI requires a Project ID to fetch models.')
    }
    const location = provider.location?.trim() || 'us-central1'
    const hasServiceAccount =
      !!provider.serviceAccountEmail?.trim() && !!provider.serviceAccountPrivateKey?.trim()
    const accessToken = hasServiceAccount
      ? await getVertexServiceAccountToken(
          provider.serviceAccountEmail!,
          provider.serviceAccountPrivateKey!,
          fetchImpl
        )
      : await (dependencies.getVertexAdcAccessToken ?? getVertexAdcAccessToken)()
    const url = `https://${location}-aiplatform.googleapis.com/v1beta1/publishers/google/models`
    console.log('[fetchModels] fetching vertex model garden:', url)
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    const body = (await response.json()) as {
      publisherModels?: VertexPublisherModel[]
    }
    return (body.publisherModels ?? [])
      .map((m) => m.name.replace(/^publishers\/google\/models\//, ''))
      .filter((id) => id.toLowerCase().startsWith('gemini'))
      .sort()
  }

  if (provider.type === 'vercel-gateway') {
    const baseUrl = normalizeGatewayBaseUrl(provider.baseUrl)
    console.log('[fetchModels] fetching gateway config:', `${baseUrl}/config`)
    const gatewayProvider = createGateway({
      apiKey: provider.apiKey,
      baseURL: baseUrl
    })
    const body = await gatewayProvider.getAvailableModels()
    return (body.models ?? [])
      .filter((model) => model.modelType === 'language' || model.modelType == null)
      .map((model) => model.id)
      .sort()
  }

  // openai and openai-responses both use the OpenAI-compatible /models endpoint
  const baseUrl = cleanBaseUrl(provider.baseUrl, DEFAULT_OPENAI_BASE_URL)
  const url = `${baseUrl}/models`
  console.log('[fetchModels] fetching openai-compatible:', url)
  const response = await fetchImpl(url, {
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
    createGatewayProvider: dependencies.createGatewayProvider ?? createGateway,
    createGoogleProvider: dependencies.createGoogleProvider ?? createGoogleGenerativeAI,
    createOpenAIProvider: dependencies.createOpenAIProvider ?? createOpenAI,
    createVertexProvider: dependencies.createVertexProvider ?? createVertex,
    streamTextImpl: dependencies.streamTextImpl ?? streamText,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch
  }

  return {
    async *streamReply(request) {
      assertConfigured(request.settings)

      const preparedMessages = prepareAiSdkMessages(request.messages)
      const providerOptions = createProviderOptions(
        request.settings,
        request.providerOptionsMode ?? 'default'
      )

      if (shouldLogGatewayDiagnostics(request.settings)) {
        logGatewayDiagnostics('streamReply-input', {
          model: request.settings.model,
          providerOptions,
          toolNames: request.tools ? Object.keys(request.tools) : []
        })
      }

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

      try {
        const result = resolvedDependencies.streamTextImpl({
          abortSignal: request.signal,
          maxRetries: DEFAULT_MAX_RETRIES,
          messages: preparedMessages,
          model: createLanguageModel(
            request.settings,
            resolvedDependencies,
            request.providerOptionsMode ?? 'default',
            resolvedDependencies.fetchImpl
          ),
          providerOptions,
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
      } catch (error) {
        if (shouldLogGatewayDiagnostics(request.settings)) {
          logGatewayDiagnostics('streamReply-error', {
            error: toSerializableError(error),
            model: request.settings.model,
            providerOptions
          })
        }

        throw error
      }
    }
  }
}
