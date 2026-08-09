import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeForOutput } from './output.ts'

test('sanitizeForOutput redacts provider credentials without changing adjacent fields', () => {
  const value = {
    name: 'vertex-work',
    apiKey: 'vertex-api-secret',
    baseUrl: 'https://example.invalid',
    project: 'public-project-id',
    serviceAccountEmail: 'agent@example.invalid',
    serviceAccountPrivateKey:
      '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
    modelList: { enabled: ['gemini-2.5-pro'], disabled: [] }
  }

  assert.deepEqual(sanitizeForOutput(value), {
    name: 'vertex-work',
    apiKey: '***',
    baseUrl: 'https://example.invalid',
    project: 'public-project-id',
    serviceAccountEmail: 'agent@example.invalid',
    serviceAccountPrivateKey: '***',
    modelList: { enabled: ['gemini-2.5-pro'], disabled: [] }
  })
})

test('sanitizeForOutput preserves empty credential fields and redacts credentials recursively', () => {
  assert.deepEqual(
    sanitizeForOutput({
      providers: [
        { apiKey: '', serviceAccountPrivateKey: '' },
        { apiKey: 'nested-api-key', serviceAccountPrivateKey: 'nested-private-key' }
      ]
    }),
    {
      providers: [
        { apiKey: '', serviceAccountPrivateKey: '' },
        { apiKey: '***', serviceAccountPrivateKey: '***' }
      ]
    }
  )
})

test('sanitizeForOutput preserves absent credential values', () => {
  assert.deepEqual(
    sanitizeForOutput({
      apiKey: null,
      serviceAccountPrivateKey: undefined
    }),
    {
      apiKey: null,
      serviceAccountPrivateKey: undefined
    }
  )
})
