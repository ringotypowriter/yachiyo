import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createOpenAiLanguageModel,
  fetchOpenAiCompatibleModels,
  shouldUseOpenAIResponsesApi
} from './openai.ts'

function encodeBase64Url(input: unknown): string {
  return Buffer.from(JSON.stringify(input)).toString('base64url')
}

function createJwt(exp: number): string {
  return `${encodeBase64Url({ alg: 'none' })}.${encodeBase64Url({ exp })}.signature`
}

test('createOpenAiLanguageModel uses the Codex backend and account headers', () => {
  let providerOptions:
    | {
        apiKey?: string
        baseURL?: string
        headers?: Record<string, string>
      }
    | undefined
  let selectedModel: { modelId: string; method: string } | undefined

  const model = createOpenAiLanguageModel(
    {
      providerName: 'codex',
      provider: 'openai-codex',
      model: 'gpt-5.1-codex-max',
      apiKey: 'oauth-access-token',
      baseUrl: 'https://ignored.example/v1',
      codexSessionPath: '/tmp/auth.json',
      codexAccountId: 'acct_123'
    },
    {
      createOpenAIProvider: (options) => {
        providerOptions = options as typeof providerOptions
        return {
          chat: () => {
            throw new Error('Codex OAuth must use the Responses API.')
          },
          responses: (modelId: string) => {
            selectedModel = { method: 'responses', modelId }
            return { method: 'responses', modelId }
          }
        } as never
      }
    } as never,
    'default'
  )

  assert.deepEqual(model, {
    method: 'responses',
    modelId: 'gpt-5.1-codex-max'
  })
  assert.deepEqual(selectedModel, {
    method: 'responses',
    modelId: 'gpt-5.1-codex-max'
  })
  assert.equal(providerOptions?.apiKey, 'oauth-access-token')
  assert.equal(providerOptions?.baseURL, 'https://chatgpt.com/backend-api/codex')
  assert.equal(providerOptions?.headers?.['ChatGPT-Account-ID'], 'acct_123')
  assert.equal(providerOptions?.headers?.originator, 'codex_cli_rs')
  assert.match(providerOptions?.headers?.['User-Agent'] ?? '', /^codex_cli_rs\//u)
})

test('shouldUseOpenAIResponsesApi enables Responses API for Codex OAuth', () => {
  assert.equal(
    shouldUseOpenAIResponsesApi({
      providerName: 'codex',
      provider: 'openai-codex',
      model: 'gpt-4.1',
      apiKey: '',
      baseUrl: '',
      codexSessionPath: '~/.codex/auth.json'
    }),
    true
  )
})

test('fetchOpenAiCompatibleModels reads Codex session auth and filters selectable models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-codex-models-'))
  const authPath = join(root, 'auth.json')
  let requestedUrl = ''
  let headers: Record<string, string> | undefined

  try {
    const accessToken = createJwt(Math.floor(Date.now() / 1000) + 3600)
    await writeFile(
      authPath,
      JSON.stringify(
        {
          tokens: {
            access_token: accessToken,
            refresh_token: 'refresh-token',
            account_id: 'acct_123'
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const models = await fetchOpenAiCompatibleModels(
      {
        id: 'provider-codex',
        name: 'Codex',
        type: 'openai-codex',
        apiKey: '',
        baseUrl: '',
        codexSessionPath: authPath,
        modelList: {
          enabled: [],
          disabled: []
        }
      },
      (async (input, init) => {
        requestedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        headers = init?.headers as Record<string, string> | undefined

        return new Response(
          JSON.stringify({
            models: [
              { slug: 'gpt-5.1-codex-max', visibility: 'list', supported_in_api: true },
              { slug: 'gpt-5.1-codex-mini', visibility: 'hidden', supported_in_api: true },
              { slug: 'gpt-5.1-codex-old', visibility: 'list', supported_in_api: false },
              { slug: 'gpt-5.1-codex', visibility: 'list' }
            ]
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      }) as typeof globalThis.fetch
    )

    assert.equal(
      requestedUrl,
      'https://chatgpt.com/backend-api/codex/models?client_version=0.125.0'
    )
    assert.deepEqual(headers, {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-ID': 'acct_123'
    })
    assert.deepEqual(models, ['gpt-5.1-codex', 'gpt-5.1-codex-max'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
