import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderConfig } from '@yachiyo/shared/protocol'

import {
  decryptProviderBackup,
  encryptProviderBackup,
  mergeProviderBackup
} from './providerBackup.ts'

const providers: ProviderConfig[] = [
  {
    id: 'provider-work',
    presetKey: 'google-vertex',
    name: 'work-vertex',
    type: 'vertex',
    thinkingEnabled: true,
    reasoning: {
      defaultEffort: 'high',
      models: [
        {
          model: 'gemini-2.5-pro',
          enabledEfforts: ['low', 'high'],
          defaultEffort: 'high',
          allowOff: true
        }
      ]
    },
    apiKey: 'secret-api-key',
    baseUrl: 'https://example.invalid/v1',
    project: 'private-project',
    location: 'us-central1',
    serviceAccountEmail: 'agent@example.invalid',
    serviceAccountPrivateKey: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    modelList: {
      enabled: ['gemini-2.5-pro'],
      disabled: ['gemini-2.0-flash'],
      imageIncapable: ['gemini-2.0-flash']
    }
  }
]

const INVALID_PROVIDER_FIXTURE =
  '{"format":"yachiyo.providers.backup","version":1,"kdf":{"name":"scrypt","cost":32768,"blockSize":8,"parallelization":1,"salt":"BwcHBwcHBwcHBwcHBwcHBw=="},"cipher":{"name":"aes-256-gcm","initializationVector":"CQkJCQkJCQkJCQkJ","authenticationTag":"9RniMolaRXRImFbHgNWLNg=="},"ciphertext":"7SFA8wg30LIYgc/d8oRJ+0a+VmXNKtaqI3mVzVPbHYVqel2Hx9EXGFjCT2+5a2u+N8jdrGK6NQKZF60KJsRIemYNwAA="}'

test('provider backup round-trips credentials without exposing plaintext', async () => {
  const encrypted = await encryptProviderBackup(providers, 'correct horse battery staple')

  assert.doesNotMatch(encrypted, /secret-api-key|private-project|work-vertex/)
  assert.deepEqual(
    await decryptProviderBackup(encrypted, 'correct horse battery staple'),
    providers
  )
})

test('provider backup rejects an incorrect password with a safe error', async () => {
  const encrypted = await encryptProviderBackup(providers, 'correct horse battery staple')

  await assert.rejects(
    () => decryptProviderBackup(encrypted, 'incorrect password'),
    /password is incorrect or the file has been modified/i
  )
})

test('provider backup requires at least eight password characters when exporting', async () => {
  await assert.rejects(
    () => encryptProviderBackup(providers, 'short'),
    /password must contain at least 8 characters/i
  )
})

test('provider backup rejects unsupported envelope versions', async () => {
  const envelope = JSON.parse(
    await encryptProviderBackup(providers, 'correct horse battery staple')
  ) as { version: number }
  envelope.version = 2

  await assert.rejects(
    () => decryptProviderBackup(JSON.stringify(envelope), 'correct horse battery staple'),
    /unsupported or invalid format/i
  )
})

test('provider backup rejects malformed binary envelope fields', async () => {
  const envelope = JSON.parse(
    await encryptProviderBackup(providers, 'correct horse battery staple')
  ) as { kdf: { salt: string } }
  envelope.kdf.salt = 'not-base64!'

  await assert.rejects(
    () => decryptProviderBackup(JSON.stringify(envelope), 'correct horse battery staple'),
    /unsupported or invalid format/i
  )
})

test('provider backup refuses to export invalid provider data', async () => {
  await assert.rejects(
    () =>
      encryptProviderBackup(
        [{ id: 'provider-invalid', name: '', apiKey: 'secret' } as ProviderConfig],
        'correct horse battery staple'
      ),
    /provider data is invalid/i
  )
})

test('provider backup refuses duplicate provider names', async () => {
  await assert.rejects(
    () =>
      encryptProviderBackup(
        [providers[0], { ...providers[0], id: 'provider-duplicate' }],
        'correct horse battery staple'
      ),
    /provider data is invalid/i
  )
})

test('provider backup requires stable provider ids', async () => {
  const providerWithoutId = { ...providers[0] }
  delete providerWithoutId.id

  await assert.rejects(
    () => encryptProviderBackup([providerWithoutId], 'correct horse battery staple'),
    /provider data is invalid/i
  )
})

test('provider backup rejects authenticated files containing invalid provider data', async () => {
  await assert.rejects(
    () => decryptProviderBackup(INVALID_PROVIDER_FIXTURE, 'correct horse battery staple'),
    /provider data is invalid/i
  )
})

test('provider backup merge updates matching names without deleting local providers', () => {
  const local: ProviderConfig[] = [
    {
      id: 'local-work-id',
      name: 'work-vertex',
      type: 'vertex',
      apiKey: 'old-key',
      baseUrl: '',
      modelList: { enabled: ['old-model'], disabled: [] }
    },
    {
      id: 'local-only-id',
      name: 'local-only',
      type: 'anthropic',
      apiKey: 'local-key',
      baseUrl: '',
      modelList: { enabled: ['claude-local'], disabled: [] }
    }
  ]
  const imported: ProviderConfig[] = [
    {
      id: 'backup-work-id',
      name: 'work-vertex',
      type: 'vertex',
      apiKey: 'new-key',
      baseUrl: '',
      modelList: { enabled: ['new-model'], disabled: [] }
    },
    {
      id: 'backup-new-id',
      name: 'backup-only',
      type: 'openai',
      apiKey: 'backup-key',
      baseUrl: 'https://example.invalid/v1',
      modelList: { enabled: ['gpt-new'], disabled: [] }
    }
  ]

  assert.deepEqual(mergeProviderBackup(local, imported), [
    { ...imported[0], id: 'local-work-id' },
    local[1],
    imported[1]
  ])
})

test('provider backup merge rejects conflicting id and name matches', () => {
  const existing: ProviderConfig[] = [
    {
      id: 'provider-a',
      name: 'alpha',
      type: 'openai',
      apiKey: '',
      baseUrl: '',
      modelList: { enabled: [], disabled: [] }
    },
    {
      id: 'provider-b',
      name: 'beta',
      type: 'anthropic',
      apiKey: '',
      baseUrl: '',
      modelList: { enabled: [], disabled: [] }
    }
  ]
  const imported: ProviderConfig[] = [{ ...existing[0], name: 'beta' }]

  assert.throws(() => mergeProviderBackup(existing, imported), /conflicting id and name/i)
})

test('provider backup merge preserves local identity when ids match', () => {
  const existing: ProviderConfig = {
    id: 'provider-work',
    name: 'local-name',
    type: 'openai',
    apiKey: 'old-key',
    baseUrl: '',
    modelList: { enabled: ['old-model'], disabled: [] }
  }
  const imported: ProviderConfig = {
    ...existing,
    name: 'backup-name',
    apiKey: 'new-key',
    modelList: { enabled: ['new-model'], disabled: [] }
  }

  assert.deepEqual(mergeProviderBackup([existing], [imported]), [
    { ...imported, name: 'local-name' }
  ])
})
