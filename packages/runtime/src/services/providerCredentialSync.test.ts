import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'

import type { ProviderConfig } from '@yachiyo/shared/protocol'
import { YachiyoServerConfigDomain } from '../app/domain/config/configDomain.ts'
import { stripProviderCredentials } from '../settings/providerCredentialConfig.ts'
import { createProviderCredentialVault } from '../settings/providerCredentialVault.ts'
import { createSettingsStore } from '../settings/settingsStore.ts'
import { syncProviderCredentials } from './providerCredentialSync.ts'

const apiKey = 'fixture-provider-api-key'
const privateKey = 'fixture-vertex-private-key'
const providers: ProviderConfig[] = [
  {
    id: 'provider-api',
    name: 'API',
    type: 'openai',
    apiKey,
    baseUrl: 'https://example.test/v1',
    modelList: { enabled: ['updated-model'], disabled: [] }
  },
  {
    id: 'provider-vertex',
    name: 'Vertex',
    type: 'vertex',
    apiKey: '',
    baseUrl: '',
    project: 'fixture-project',
    serviceAccountPrivateKey: privateKey,
    modelList: { enabled: ['vertex-model'], disabled: [] }
  }
]

function setup(): {
  root: string
  syncDir: string
  device: (
    id: string,
    keyByte: number
  ) => {
    domain: YachiyoServerConfigDomain
    cycle: () => boolean
    home: string
  }
} {
  const root = mkdtempSync(join(tmpdir(), 'yachiyo-credential-sync-'))
  const syncDir = join(root, 'sync')
  mkdirSync(syncDir)
  writeFileSync(join(syncDir, 'universe.json'), JSON.stringify({ universeId: 'fixture-universe' }))
  return {
    root,
    syncDir,
    device(id, keyByte) {
      const home = join(root, id)
      const deviceDir = join(syncDir, 'devices', id)
      mkdirSync(deviceDir, { recursive: true })
      writeFileSync(join(deviceDir, 'manifest.json'), JSON.stringify({ deviceId: id }))
      const vault = createProviderCredentialVault({
        vaultPath: join(home, 'provider-credentials.enc'),
        encryptionKey: Buffer.alloc(32, keyByte)
      })
      const domain = new YachiyoServerConfigDomain({
        settingsStore: createSettingsStore(join(home, 'config.toml'), {
          providerCredentialVault: vault
        }),
        emit: () => {}
      })
      return {
        home,
        domain,
        cycle: () =>
          syncProviderCredentials({
            home,
            syncDir,
            deviceId: id,
            vault,
            providerIds: domain.getConfig().providers.map((provider) => provider.id!),
            apply: (credentials) => domain.applySyncedProviderCredentials(credentials)
          })
      }
    }
  }
}

function files(root: string, dir = root): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory()
        ? Object.entries(files(root, path))
        : [[relative(root, path), readFileSync(path, 'utf8')]]
    })
  )
}

test('devices automatically agree a key and sync credentials into the receiving local vault', () => {
  const fixture = setup()
  try {
    const b = fixture.device('device-b', 2)
    const a = fixture.device('device-a', 1)
    b.domain.saveConfig({ providers })
    a.domain.applySyncedConfig(stripProviderCredentials(b.domain.getConfig()))
    assert.equal(a.domain.getConfig().providers[0].apiKey, '')

    b.cycle()
    a.cycle()
    b.cycle()
    a.cycle()

    const received = a.domain.getConfig()
    assert.equal(received.providers[0].apiKey, apiKey)
    assert.equal(received.providers[1].serviceAccountPrivateKey, privateKey)
    assert.deepEqual(received.providers[0].modelList.enabled, ['updated-model'])
    for (const content of Object.values(files(fixture.root))) {
      assert.ok(!content.includes(apiKey), 'API keys must never be stored as plaintext')
      assert.ok(
        !content.includes(privateKey),
        'Vertex private keys must never be stored as plaintext'
      )
    }

    const reopened = fixture.device('device-a', 1)
    assert.equal(reopened.domain.getConfig().providers[0].apiKey, apiKey)
    b.cycle()
    reopened.cycle()
    const before = files(fixture.syncDir)
    assert.equal(b.cycle(), false)
    assert.equal(reopened.cycle(), false)
    assert.deepEqual(
      files(fixture.syncDir),
      before,
      'unchanged credentials must not be republished'
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('credential-only updates and deletions sync without replaying old credentials', () => {
  const fixture = setup()
  try {
    const b = fixture.device('device-b', 2)
    const a = fixture.device('device-a', 1)
    b.domain.saveConfig({ providers })
    a.domain.applySyncedConfig(stripProviderCredentials(b.domain.getConfig()))
    b.cycle()
    a.cycle()
    b.cycle()
    a.cycle()

    const config = b.domain.getConfig()
    config.providers[0].apiKey = 'fixture-rotated-key'
    b.domain.saveConfig(config)
    b.cycle()
    a.cycle()
    assert.equal(a.domain.getConfig().providers[0].apiKey, 'fixture-rotated-key')
    const envelopePath = join(
      fixture.syncDir,
      'devices/device-b/provider-credentials/device-a.json'
    )
    const staleEnvelope = readFileSync(envelopePath, 'utf8')

    config.providers[0].apiKey = ''
    config.providers[1].serviceAccountPrivateKey = ''
    b.domain.saveConfig(config)
    b.cycle()
    a.cycle()
    assert.equal(a.domain.getConfig().providers[0].apiKey, '')
    assert.equal(a.domain.getConfig().providers[1].serviceAccountPrivateKey, '')
    writeFileSync(envelopePath, staleEnvelope)
    a.cycle()
    assert.equal(a.domain.getConfig().providers[0].apiKey, '')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('credentials can arrive before provider settings and be relayed while the source is offline', () => {
  const fixture = setup()
  try {
    const b = fixture.device('device-b', 2)
    const a = fixture.device('device-a', 1)
    b.domain.saveConfig({ providers })
    a.domain.saveConfig({ providers: [] })
    b.cycle()
    a.cycle()
    b.cycle()
    a.cycle()
    a.domain.saveConfig({ providers: [], general: { contextTimeZone: 'UTC' } })
    a.cycle()
    a.domain.applySyncedConfig(stripProviderCredentials(b.domain.getConfig()))
    assert.equal(a.domain.getConfig().providers[0].apiKey, apiKey)

    const c = fixture.device('device-c', 3)
    c.domain.applySyncedConfig(stripProviderCredentials(a.domain.getConfig()))
    c.cycle()
    a.cycle()
    c.cycle()
    assert.equal(c.domain.getConfig().providers[0].apiKey, apiKey)
    assert.equal(c.domain.getConfig().providers[1].serviceAccountPrivateKey, privateKey)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('tampered ciphertext and changed device public keys fail without changing credentials', () => {
  const fixture = setup()
  try {
    const b = fixture.device('device-b', 2)
    const a = fixture.device('device-a', 1)
    b.domain.saveConfig({ providers })
    a.domain.applySyncedConfig(stripProviderCredentials(b.domain.getConfig()))
    b.cycle()
    a.cycle()
    b.cycle()
    const envelopePath = join(
      fixture.syncDir,
      'devices/device-b/provider-credentials/device-a.json'
    )
    const original = readFileSync(envelopePath, 'utf8')
    const tampered = JSON.parse(original)
    const ciphertext = Buffer.from(tampered.ciphertext, 'base64')
    ciphertext[0] ^= 1
    tampered.ciphertext = ciphertext.toString('base64')
    writeFileSync(envelopePath, JSON.stringify(tampered))
    assert.throws(() => a.cycle())
    assert.equal(a.domain.getConfig().providers[0].apiKey, '')
    writeFileSync(envelopePath, original)
    a.cycle()
    assert.equal(a.domain.getConfig().providers[0].apiKey, apiKey)

    const c = fixture.device('device-c', 3)
    c.cycle()
    const peerPath = join(fixture.syncDir, 'devices/device-b/provider-credentials-key.json')
    const peer = JSON.parse(readFileSync(peerPath, 'utf8'))
    peer.publicKey = JSON.parse(
      readFileSync(join(fixture.syncDir, 'devices/device-c/provider-credentials-key.json'), 'utf8')
    ).publicKey
    writeFileSync(peerPath, JSON.stringify(peer))
    assert.throws(() => a.cycle(), /public key changed/)
    assert.equal(a.domain.getConfig().providers[0].apiKey, apiKey)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('concurrent credential edits converge regardless of device sync order', () => {
  for (const order of ['ab', 'ba']) {
    const fixture = setup()
    try {
      const b = fixture.device('device-b', 2)
      const a = fixture.device('device-a', 1)
      b.domain.saveConfig({ providers })
      a.domain.applySyncedConfig(stripProviderCredentials(b.domain.getConfig()))
      b.cycle()
      a.cycle()
      b.cycle()
      a.cycle()
      b.cycle()
      const left = a.domain.getConfig()
      const right = b.domain.getConfig()
      left.providers[0].apiKey = 'fixture-concurrent-a'
      right.providers[0].apiKey = 'fixture-concurrent-b'
      a.domain.saveConfig(left)
      b.domain.saveConfig(right)
      for (const side of `${order}${order}${order}`) {
        if (side === 'a') a.cycle()
        else b.cycle()
      }
      assert.equal(a.domain.getConfig().providers[0].apiKey, 'fixture-concurrent-b')
      assert.equal(b.domain.getConfig().providers[0].apiKey, 'fixture-concurrent-b')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test('a settings save removes explicitly deleted providers without deleting pending credentials', () => {
  const fixture = setup()
  try {
    const b = fixture.device('device-b', 2)
    const a = fixture.device('device-a', 1)
    b.domain.saveConfig({ providers })
    a.domain.applySyncedConfig(stripProviderCredentials(b.domain.getConfig()))
    b.cycle()
    a.cycle()
    b.cycle()
    a.cycle()
    b.domain.saveConfig({ providers: [b.domain.getConfig().providers[1]] })
    b.cycle()
    a.cycle()
    assert.equal(a.domain.getConfig().providers[0].apiKey, '')
    assert.equal(a.domain.getConfig().providers[1].serviceAccountPrivateKey, privateKey)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
