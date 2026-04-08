import { createGateway, type LanguageModel } from 'ai'

import type { ProviderConfig, ProviderSettings } from '../../../../shared/yachiyo/protocol'
import type { ResolvedAiSdkRuntimeDependencies } from './dependencies.ts'
import {
  cleanBaseUrl,
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_VERCEL_GATEWAY_THINKING_LEVEL,
  type RuntimeProviderOptions
} from './shared.ts'

export function isVercelGatewayBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'ai-gateway.vercel.sh'
  } catch {
    return baseUrl.includes('ai-gateway.vercel.sh')
  }
}

export function normalizeGatewayBaseUrl(baseUrl: string): string {
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

export function toSerializableError(error: unknown): Record<string, unknown> {
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

export function logGatewayDiagnostics(label: string, payload: unknown): void {
  console.log(`[gateway-diagnostic] ${label}\n${safeJsonStringify(payload)}`)
}

export function isVercelGatewayGoogleModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith('google/')
}

export function supportsVercelGatewayThinkingLevel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()

  return normalized.startsWith('google/gemini-3') || normalized.startsWith('google/gemini-3.1')
}

export function shouldLogGatewayDiagnostics(settings: ProviderSettings): boolean {
  if (settings.provider !== 'openai' && settings.provider !== 'vercel-gateway') {
    return false
  }

  const normalizedModel = settings.model.trim().toLowerCase()
  const normalizedBaseUrl =
    settings.provider === 'vercel-gateway'
      ? normalizeGatewayBaseUrl(settings.baseUrl)
      : cleanBaseUrl(settings.baseUrl, 'https://api.openai.com/v1')

  return normalizedModel.startsWith('google/gemini') && isVercelGatewayBaseUrl(normalizedBaseUrl)
}

export function createGatewayDiagnosticFetch(
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

export function createGatewayLanguageModel(
  settings: ProviderSettings,
  dependencies: ResolvedAiSdkRuntimeDependencies,
  diagnosticFetch?: typeof globalThis.fetch
): LanguageModel {
  const provider = dependencies.createGatewayProvider({
    apiKey: settings.apiKey,
    baseURL: normalizeGatewayBaseUrl(settings.baseUrl),
    ...(diagnosticFetch ? { fetch: diagnosticFetch } : {})
  })

  return provider(settings.model)
}

export function createGatewayProviderOptions(
  settings: ProviderSettings,
  mode: 'default' | 'auxiliary' = 'default'
): RuntimeProviderOptions {
  if (!isVercelGatewayGoogleModel(settings.model)) {
    return {}
  }

  if (mode === 'auxiliary') {
    return {
      gateway: {
        order: ['vertex']
      }
    }
  }

  return supportsVercelGatewayThinkingLevel(settings.model) && settings.thinkingEnabled !== false
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

export async function fetchGatewayModels(provider: ProviderConfig): Promise<string[]> {
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
