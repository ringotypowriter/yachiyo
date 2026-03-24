import { createSign } from 'node:crypto'

import type { LanguageModel } from 'ai'
import { GoogleAuth } from 'google-auth-library'

import type { ProviderConfig, ProviderSettings } from '../../../../shared/yachiyo/protocol'
import type { FetchModelsDependencies, ResolvedAiSdkRuntimeDependencies } from './dependencies.ts'
import { DEFAULT_GEMINI_THINKING_BUDGET, type RuntimeProviderOptions } from './shared.ts'
import { supportsGeminiThinking } from './google.ts'

export function createVertexLanguageModel(
  settings: ProviderSettings,
  dependencies: ResolvedAiSdkRuntimeDependencies,
  fetchImpl?: typeof globalThis.fetch
): LanguageModel {
  const project = settings.project ?? ''
  const location = settings.location ?? 'us-central1'
  const hasServiceAccount =
    !!settings.serviceAccountEmail?.trim() && !!settings.serviceAccountPrivateKey?.trim()

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

export function createVertexProviderOptions(settings: ProviderSettings): RuntimeProviderOptions {
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

export async function getVertexServiceAccountToken(
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

export async function getVertexAdcAccessToken(): Promise<string> {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  })
  const accessToken = await auth.getAccessToken()

  if (!accessToken) {
    throw new Error('Failed to obtain Vertex access token from Application Default Credentials.')
  }

  return accessToken
}

export async function fetchVertexModels(
  provider: ProviderConfig,
  fetchImpl: typeof globalThis.fetch,
  dependencies: FetchModelsDependencies = {}
): Promise<string[]> {
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
  const body = (await response.json()) as { publisherModels?: Array<{ name: string }> }
  return (body.publisherModels ?? [])
    .map((model) => model.name.replace(/^publishers\/google\/models\//, ''))
    .filter((id) => id.toLowerCase().startsWith('gemini'))
    .sort()
}
