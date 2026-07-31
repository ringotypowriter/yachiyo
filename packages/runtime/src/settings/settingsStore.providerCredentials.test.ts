import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createProviderCredentialVault } from './providerCredentialVault.ts'
import { createSettingsStore } from './settingsStore.ts'

test('settings store migrates legacy provider credentials out of config.toml', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-migration-'))
  const settingsPath = join(root, 'config.toml')
  const vaultPath = join(root, 'provider-credentials.enc')
  const legacyApiKey = 'sk-legacy-provider-secret'
  const legacyPrivateKey = 'legacy-vertex-private-key'
  const encryptionKey = Buffer.alloc(32, 0x3c)

  await writeFile(
    settingsPath,
    `[[providers]]
id = "provider-work"
name = "work"
type = "vertex"
apiKey = "${legacyApiKey}"
baseUrl = ""
project = "project-id"
location = "us-central1"
serviceAccountEmail = "service@example.com"
serviceAccountPrivateKey = "${legacyPrivateKey}"

[providers.modelList]
enabled = [ "gemini-2.5-pro" ]
disabled = []
`,
    'utf8'
  )

  try {
    const vault = createProviderCredentialVault({ vaultPath, encryptionKey })
    const store = createSettingsStore(settingsPath, { providerCredentialVault: vault })

    const migrated = store.read().providers[0]
    assert.equal(migrated?.apiKey, legacyApiKey)
    assert.equal(migrated?.serviceAccountPrivateKey, legacyPrivateKey)

    const persistedSettings = await readFile(settingsPath, 'utf8')
    assert.doesNotMatch(persistedSettings, new RegExp(legacyApiKey))
    assert.doesNotMatch(persistedSettings, new RegExp(legacyPrivateKey))

    const reopened = createSettingsStore(settingsPath, {
      providerCredentialVault: createProviderCredentialVault({ vaultPath, encryptionKey })
    }).read()
    assert.equal(reopened.providers[0]?.apiKey, legacyApiKey)
    assert.equal(reopened.providers[0]?.serviceAccountPrivateKey, legacyPrivateKey)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy plaintext remains recoverable when the credential vault write fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-migration-failure-'))
  const settingsPath = join(root, 'config.toml')
  const legacyApiKey = 'sk-recoverable-legacy-secret'
  await writeFile(
    settingsPath,
    `[[providers]]
id = "provider-recoverable"
name = "recoverable"
type = "anthropic"
apiKey = "${legacyApiKey}"
baseUrl = ""

[providers.modelList]
enabled = [ "claude-sonnet-4-5" ]
disabled = []
`,
    'utf8'
  )

  try {
    const store = createSettingsStore(settingsPath, {
      providerCredentialVault: {
        exists: () => false,
        read: () => ({}),
        write: () => {
          throw new Error('credential vault unavailable')
        }
      }
    })

    assert.throws(() => store.read(), /credential vault unavailable/u)
    assert.match(await readFile(settingsPath, 'utf8'), new RegExp(legacyApiKey))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('settings store writes new provider credentials only to the encrypted vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-write-'))
  const settingsPath = join(root, 'config.toml')
  const vaultPath = join(root, 'provider-credentials.enc')
  const apiKey = 'sk-new-provider-secret'
  const privateKey = 'new-vertex-private-key'
  const encryptionKey = Buffer.alloc(32, 0x4d)
  const store = createSettingsStore(settingsPath, {
    providerCredentialVault: createProviderCredentialVault({ vaultPath, encryptionKey })
  })

  try {
    store.write({
      providers: [
        {
          id: 'provider-new',
          name: 'new-provider',
          type: 'vertex',
          apiKey,
          baseUrl: '',
          project: 'project-id',
          serviceAccountPrivateKey: privateKey,
          modelList: { enabled: ['gemini-2.5-pro'], disabled: [] }
        }
      ]
    })

    const persistedSettings = await readFile(settingsPath, 'utf8')
    assert.doesNotMatch(persistedSettings, new RegExp(apiKey))
    assert.doesNotMatch(persistedSettings, new RegExp(privateKey))

    const reopened = createSettingsStore(settingsPath, {
      providerCredentialVault: createProviderCredentialVault({ vaultPath, encryptionKey })
    }).read()
    assert.equal(reopened.providers[0]?.apiKey, apiKey)
    assert.equal(reopened.providers[0]?.serviceAccountPrivateKey, privateKey)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('settings store preserves local credentials when writing synced public settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-sync-'))
  const settingsPath = join(root, 'config.toml')
  const vault = createProviderCredentialVault({
    vaultPath: join(root, 'provider-credentials.enc'),
    encryptionKey: Buffer.alloc(32, 0x6e)
  })
  const store = createSettingsStore(settingsPath, { providerCredentialVault: vault })

  try {
    store.write({
      providers: [
        {
          id: 'provider-synced',
          name: 'synced-provider',
          type: 'anthropic',
          apiKey: 'sk-device-local',
          baseUrl: '',
          modelList: { enabled: ['claude-sonnet-4-5'], disabled: [] }
        }
      ]
    })

    store.write(
      {
        providers: [
          {
            id: 'provider-synced',
            name: 'synced-provider',
            type: 'anthropic',
            apiKey: 'sk-from-legacy-sync-history',
            baseUrl: '',
            modelList: {
              enabled: ['claude-opus-4-6'],
              disabled: ['claude-sonnet-4-5']
            }
          }
        ]
      },
      { providerCredentials: 'preserve' }
    )

    const reloaded = store.read().providers[0]
    assert.equal(reloaded?.apiKey, 'sk-device-local')
    assert.deepEqual(reloaded?.modelList, {
      enabled: ['claude-opus-4-6'],
      disabled: ['claude-sonnet-4-5']
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('settings store ignores legacy plaintext credentials imported after migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-import-'))
  const settingsPath = join(root, 'config.toml')
  const vaultPath = join(root, 'provider-credentials.enc')
  const encryptionKey = Buffer.alloc(32, 0x27)
  const vault = createProviderCredentialVault({ vaultPath, encryptionKey })
  const store = createSettingsStore(settingsPath, { providerCredentialVault: vault })

  try {
    store.write({
      providers: [
        {
          id: 'provider-imported',
          name: 'provider-imported',
          type: 'anthropic',
          apiKey: 'sk-device-local',
          baseUrl: '',
          modelList: { enabled: ['claude-sonnet-4-5'], disabled: [] }
        }
      ]
    })

    await writeFile(
      settingsPath,
      `[[providers]]
id = "provider-imported"
name = "provider-imported"
type = "anthropic"
apiKey = "sk-from-legacy-sync-history"
baseUrl = ""

[providers.modelList]
enabled = [ "claude-opus-4-6" ]
disabled = []
`,
      'utf8'
    )

    const imported = createSettingsStore(settingsPath, {
      providerCredentialVault: createProviderCredentialVault({ vaultPath, encryptionKey })
    }).read()

    assert.equal(imported.providers[0]?.apiKey, 'sk-device-local')
    assert.deepEqual(imported.providers[0]?.modelList.enabled, ['claude-opus-4-6'])
    assert.doesNotMatch(await readFile(settingsPath, 'utf8'), /sk-from-legacy-sync-history/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
