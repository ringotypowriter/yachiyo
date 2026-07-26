import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderSettings } from '@yachiyo/shared/protocol'
import { resolveMissingCredentialIssue } from './providerCredentials.ts'

function settings(overrides: Partial<ProviderSettings>): ProviderSettings {
  return {
    providerName: 'provider',
    provider: 'openai',
    model: 'some-model',
    apiKey: '',
    baseUrl: '',
    ...overrides
  }
}

test('accepts an API-key provider that has a key', () => {
  assert.equal(resolveMissingCredentialIssue(settings({ apiKey: 'sk-test' })), null)
})

test('reports a missing API key', () => {
  assert.equal(resolveMissingCredentialIssue(settings({})), 'missing-api-key')
})

test('accepts Codex OAuth authenticated by a session path', () => {
  assert.equal(
    resolveMissingCredentialIssue(
      settings({ provider: 'openai-codex', codexSessionPath: '~/.codex/auth.json' })
    ),
    null
  )
})

test('reports a missing Codex session path', () => {
  assert.equal(
    resolveMissingCredentialIssue(settings({ provider: 'openai-codex' })),
    'missing-codex-session'
  )
})

test('accepts Vertex authenticated by a project', () => {
  assert.equal(
    resolveMissingCredentialIssue(settings({ provider: 'vertex', project: 'gen-lang-client' })),
    null
  )
})

test('reports a missing Vertex project', () => {
  assert.equal(
    resolveMissingCredentialIssue(settings({ provider: 'vertex' })),
    'missing-vertex-project'
  )
})
