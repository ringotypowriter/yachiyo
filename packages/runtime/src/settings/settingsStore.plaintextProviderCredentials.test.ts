import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { resolveYachiyoPlaintextProviderCredentialVaultPath } from '../config/paths.ts'
import { createPlaintextProviderCredentialVault } from './plaintextProviderCredentialVault.ts'
import { createSettingsStore } from './settingsStore.ts'

const fixtureApiKey = 'example-local-api-key-not-a-secret'
const fixturePrivateKey = 'example-local-private-key-not-a-secret'
const fixtureProvider = {
  id: 'provider-fixture',
  name: 'Fixture provider',
  type: 'vertex' as const,
  apiKey: fixtureApiKey,
  serviceAccountPrivateKey: fixturePrivateKey,
  project: 'example-project',
  baseUrl: '',
  modelList: { enabled: ['gemini-2.5-pro'], disabled: [] }
}
const legacyConfig = `[[providers]]
id = "provider-fixture"
name = "Fixture provider"
type = "vertex"
apiKey = "${fixtureApiKey}"
serviceAccountPrivateKey = "${fixturePrivateKey}"
project = "example-project"
baseUrl = ""

[providers.modelList]
enabled = [ "gemini-2.5-pro" ]
disabled = []
`

async function createFixture(t: TestContext): Promise<{
  root: string
  settingsPath: string
  vaultPath: string
  vault: ReturnType<typeof createPlaintextProviderCredentialVault>
}> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-plaintext-settings-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const settingsPath = join(root, 'config.toml')
  const vaultPath = resolveYachiyoPlaintextProviderCredentialVaultPath(root)
  const vault = createPlaintextProviderCredentialVault({ vaultPath })
  return { root, settingsPath, vaultPath, vault }
}

test('legacy config credentials are stripped only after a successful plaintext vault write', async (t) => {
  const { settingsPath, vaultPath, vault } = await createFixture(t)
  await writeFile(settingsPath, legacyConfig)
  let writes = 0
  const store = createSettingsStore(settingsPath, {
    providerCredentialVault: {
      ...vault,
      write(credentials): void {
        assert.equal(readFileSync(settingsPath, 'utf8'), legacyConfig)
        vault.write(credentials)
        writes += 1
      }
    }
  })

  const provider = store.read().providers[0]
  assert.equal(writes, 1)
  assert.equal(provider?.apiKey, fixtureApiKey)
  assert.equal(provider?.serviceAccountPrivateKey, fixturePrivateKey)
  assert.deepEqual(vault.read(), {
    'provider-fixture': { apiKey: fixtureApiKey, serviceAccountPrivateKey: fixturePrivateKey }
  })
  const publicConfig = await readFile(settingsPath, 'utf8')
  assert.equal(publicConfig.includes(fixtureApiKey), false)
  assert.equal(publicConfig.includes(fixturePrivateKey), false)

  const reopened = createSettingsStore(settingsPath, {
    providerCredentialVault: createPlaintextProviderCredentialVault({ vaultPath })
  }).read()
  assert.equal(reopened.providers[0]?.apiKey, fixtureApiKey)
  assert.equal(reopened.providers[0]?.serviceAccountPrivateKey, fixturePrivateKey)
})

test('a failed plaintext vault write leaves legacy config credentials recoverable', async (t) => {
  const { settingsPath, vault } = await createFixture(t)
  await writeFile(settingsPath, legacyConfig)
  const store = createSettingsStore(settingsPath, {
    providerCredentialVault: {
      ...vault,
      write(): void {
        throw new Error('fixture plaintext write failure')
      }
    }
  })

  assert.throws(() => store.read(), /fixture plaintext write failure/)
  assert.equal(await readFile(settingsPath, 'utf8'), legacyConfig)
  assert.equal(vault.exists(), false)
})

test('corrupt plaintext vault leaves legacy config and vault bytes unchanged', async (t) => {
  const { settingsPath, vaultPath, vault } = await createFixture(t)
  const malformedFixture = '{"version":1,"storage":"plaintext","credentials":'
  await writeFile(settingsPath, legacyConfig)
  await writeFile(vaultPath, malformedFixture)
  const store = createSettingsStore(settingsPath, { providerCredentialVault: vault })

  assert.throws(() => store.read(), /unsupported format/)
  assert.throws(() => store.write({ providers: [fixtureProvider] }), /unsupported format/)
  assert.equal(await readFile(settingsPath, 'utf8'), legacyConfig)
  assert.equal(await readFile(vaultPath, 'utf8'), malformedFixture)
})

test('sync-style preserve writes retain both device-local plaintext credentials', async (t) => {
  const { settingsPath, vaultPath, vault } = await createFixture(t)
  const store = createSettingsStore(settingsPath, { providerCredentialVault: vault })
  store.write({ providers: [fixtureProvider] })
  const originalVault = await readFile(vaultPath)

  store.write(
    {
      providers: [
        {
          ...fixtureProvider,
          apiKey: 'example-stale-synced-api-key',
          serviceAccountPrivateKey: 'example-stale-synced-private-key',
          modelList: { enabled: ['gemini-2.5-flash'], disabled: ['gemini-2.5-pro'] }
        }
      ]
    },
    { providerCredentials: 'preserve' }
  )

  assert.deepEqual(await readFile(vaultPath), originalVault)
  const provider = store.read().providers[0]
  assert.equal(provider?.apiKey, fixtureApiKey)
  assert.equal(provider?.serviceAccountPrivateKey, fixturePrivateKey)
  assert.deepEqual(provider?.modelList, {
    enabled: ['gemini-2.5-flash'],
    disabled: ['gemini-2.5-pro']
  })
  const publicConfig = await readFile(settingsPath, 'utf8')
  for (const secret of [
    fixtureApiKey,
    fixturePrivateKey,
    'example-stale-synced-api-key',
    'example-stale-synced-private-key'
  ]) {
    assert.equal(publicConfig.includes(secret), false)
  }
})

test('imported legacy config cannot overwrite an existing plaintext vault', async (t) => {
  const { settingsPath, vaultPath, vault } = await createFixture(t)
  createSettingsStore(settingsPath, { providerCredentialVault: vault }).write({
    providers: [fixtureProvider]
  })
  const originalVault = await readFile(vaultPath)
  await writeFile(
    settingsPath,
    legacyConfig
      .replace(fixtureApiKey, 'example-imported-stale-api-key')
      .replace(fixturePrivateKey, 'example-imported-stale-private-key')
  )

  const imported = createSettingsStore(settingsPath, {
    providerCredentialVault: createPlaintextProviderCredentialVault({ vaultPath })
  }).read()
  assert.equal(imported.providers[0]?.apiKey, fixtureApiKey)
  assert.equal(imported.providers[0]?.serviceAccountPrivateKey, fixturePrivateKey)
  assert.deepEqual(await readFile(vaultPath), originalVault)
  const publicConfig = await readFile(settingsPath, 'utf8')
  assert.equal(publicConfig.includes('example-imported-stale-api-key'), false)
  assert.equal(publicConfig.includes('example-imported-stale-private-key'), false)
})
