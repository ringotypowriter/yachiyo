import assert from 'node:assert/strict'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  resolveYachiyoPlaintextProviderCredentialVaultPath,
  resolveYachiyoProviderCredentialKeyPath,
  resolveYachiyoProviderCredentialVaultPath
} from '../config/paths.ts'
import { createPlaintextProviderCredentialVault } from './plaintextProviderCredentialVault.ts'
import type { ProviderCredentialSnapshot } from './providerCredentialVault.ts'

const credentials = {
  'provider-fixture': {
    apiKey: 'example-api-key-not-a-secret',
    serviceAccountPrivateKey: 'example-service-account-fixture\nsecond line'
  },
  'provider-empty': {}
}

function envelope(value: unknown = credentials): string {
  return JSON.stringify({ version: 1, storage: 'plaintext', credentials: value })
}

async function createFixture(t: TestContext): Promise<{
  root: string
  vaultPath: string
  vault: ReturnType<typeof createPlaintextProviderCredentialVault>
}> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-plaintext-provider-credentials-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const vaultPath = resolveYachiyoPlaintextProviderCredentialVaultPath(root)
  return { root, vaultPath, vault: createPlaintextProviderCredentialVault({ vaultPath }) }
}

test('plaintext vault path is separate from the encrypted vault and key', () => {
  const root = join(tmpdir(), 'yachiyo-path-fixture')
  assert.equal(
    resolveYachiyoPlaintextProviderCredentialVaultPath(root),
    join(root, 'provider-credentials.plaintext.json')
  )
  assert.notEqual(
    resolveYachiyoPlaintextProviderCredentialVaultPath(root),
    resolveYachiyoProviderCredentialVaultPath(root)
  )
  assert.notEqual(
    resolveYachiyoPlaintextProviderCredentialVaultPath(root),
    resolveYachiyoProviderCredentialKeyPath(root)
  )
})

test('missing plaintext vault reads empty without creating files', async (t) => {
  const { root, vault } = await createFixture(t)
  assert.equal(vault.exists(), false)
  assert.deepEqual(vault.read(), {})
  assert.deepEqual(await readdir(root), [])
})

test('plaintext vault round-trips a distinct versioned envelope and fresh instances', async (t) => {
  const { root, vaultPath, vault } = await createFixture(t)
  vault.write(credentials)
  assert.equal(vault.exists(), true)
  assert.deepEqual(vault.read(), credentials)
  assert.deepEqual(createPlaintextProviderCredentialVault({ vaultPath }).read(), credentials)
  assert.deepEqual(JSON.parse(await readFile(vaultPath, 'utf8')), {
    version: 1,
    storage: 'plaintext',
    credentials
  })
  assert.deepEqual(await readdir(root), ['provider-credentials.plaintext.json'])

  vault.write({})
  assert.deepEqual(vault.read(), {})
})

test('plaintext vault creates missing parent directories', async (t) => {
  const { root } = await createFixture(t)
  const vaultPath = join(root, 'nested', 'settings', 'provider-credentials.plaintext.json')
  const vault = createPlaintextProviderCredentialVault({ vaultPath })
  vault.write(credentials)
  assert.deepEqual(vault.read(), credentials)
})

test('plaintext vault never changes the adjacent encrypted vault or key', async (t) => {
  const { root, vault } = await createFixture(t)
  const encryptedPath = resolveYachiyoProviderCredentialVaultPath(root)
  const keyPath = resolveYachiyoProviderCredentialKeyPath(root)
  const encryptedFixture = Buffer.from('encrypted-file-fixture-not-real-ciphertext\u0000')
  const keyFixture = Buffer.from('key-file-fixture-not-a-real-key\u0000')
  await writeFile(encryptedPath, encryptedFixture)
  await writeFile(keyPath, keyFixture)

  assert.deepEqual(vault.read(), {})
  vault.write(credentials)
  vault.write({ 'provider-replacement': { apiKey: 'another-example-fixture' } })

  assert.deepEqual(await readFile(encryptedPath), encryptedFixture)
  assert.deepEqual(await readFile(keyPath), keyFixture)
  assert.deepEqual((await readdir(root)).sort(), [
    'provider-credentials.enc',
    'provider-credentials.key',
    'provider-credentials.plaintext.json'
  ])
})

test(
  'plaintext vault writes owner-only files, including when replacing a broader-permission file',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { vaultPath, vault } = await createFixture(t)
    vault.write(credentials)
    assert.equal((await stat(vaultPath)).mode & 0o777, 0o600)

    await rm(vaultPath)
    await writeFile(vaultPath, envelope(), { mode: 0o644 })
    vault.write({})
    assert.equal((await stat(vaultPath)).mode & 0o777, 0o600)
  }
)

test(
  'plaintext vault replaces the complete file instead of truncating an open previous version',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { vaultPath, vault } = await createFixture(t)
    vault.write(credentials)
    const previous = await readFile(vaultPath, 'utf8')
    const fd = openSync(vaultPath, 'r')
    try {
      vault.write({})
      assert.equal(readFileSync(fd, 'utf8'), previous)
      assert.deepEqual(vault.read(), {})
    } finally {
      closeSync(fd)
    }
  }
)

const unsupportedFiles = [
  ['malformed JSON', '{'],
  ['null envelope', 'null'],
  ['array envelope', '[]'],
  ['bare credential map', JSON.stringify(credentials)],
  ['unsupported version', JSON.stringify({ version: 2, storage: 'plaintext', credentials })],
  ['incorrect storage', JSON.stringify({ version: 1, storage: 'encrypted', credentials })],
  [
    'extra envelope field',
    JSON.stringify({ version: 1, storage: 'plaintext', credentials, extra: 1 })
  ],
  ['missing credentials', JSON.stringify({ version: 1, storage: 'plaintext' })],
  ['null credential map', envelope(null)],
  ['array credential map', envelope([])],
  ['null provider credentials', envelope({ provider: null })],
  ['array provider credentials', envelope({ provider: [] })],
  ['unsupported provider field', envelope({ provider: { accessToken: 'example-fixture' } })],
  ['non-string API key', envelope({ provider: { apiKey: 7 } })],
  ['non-string private key', envelope({ provider: { serviceAccountPrivateKey: null } })],
  ['blank provider id', envelope({ ' ': {} })],
  ['unsafe provider id', envelope(JSON.parse('{"__proto__":{"apiKey":"example-fixture"}}'))],
  [
    'encrypted envelope',
    JSON.stringify({
      version: 1,
      algorithm: 'aes-256-gcm',
      initializationVector: 'example-fixture',
      authenticationTag: 'example-fixture',
      ciphertext: 'example-fixture'
    })
  ]
]

for (const [label, raw] of unsupportedFiles) {
  test(`plaintext vault rejects ${label} without replacing the file`, async (t) => {
    const { root, vaultPath, vault } = await createFixture(t)
    await writeFile(vaultPath, raw)
    assert.equal(vault.exists(), true)
    assert.throws(() => vault.read(), /unsupported format/)
    assert.throws(() => vault.write(credentials), /unsupported format/)
    assert.equal(await readFile(vaultPath, 'utf8'), raw)
    assert.deepEqual(await readdir(root), ['provider-credentials.plaintext.json'])
  })
}

test('plaintext vault rejects invalid write input without changing existing files', async (t) => {
  const { vaultPath, vault } = await createFixture(t)
  vault.write(credentials)
  const previous = await readFile(vaultPath)
  assert.throws(
    () => vault.write({ provider: { apiKey: 42 } } as unknown as ProviderCredentialSnapshot),
    /unsupported format/
  )
  assert.deepEqual(await readFile(vaultPath), previous)
})

test('plaintext vault rejects a directory path without changing its contents', async (t) => {
  const { root } = await createFixture(t)
  const vault = createPlaintextProviderCredentialVault({ vaultPath: root })
  assert.throws(() => vault.exists(), /regular file/)
  assert.throws(() => vault.read(), /regular file/)
  assert.throws(() => vault.write(credentials), /regular file/)
  assert.deepEqual(await readdir(root), [])
})

test(
  'plaintext vault refuses symlinks without reading or replacing their target',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, vaultPath, vault } = await createFixture(t)
    const targetPath = resolveYachiyoProviderCredentialKeyPath(root)
    const keyFixture = 'key-file-fixture-not-a-real-key'
    await writeFile(targetPath, keyFixture)
    await symlink(targetPath, vaultPath)
    assert.throws(() => vault.exists(), /regular file/)
    assert.throws(() => vault.read(), /regular file/)
    assert.throws(() => vault.write(credentials), /regular file/)
    assert.equal(await readFile(targetPath, 'utf8'), keyFixture)

    await rm(targetPath)
    assert.throws(() => vault.exists(), /regular file/)
    assert.throws(() => vault.write(credentials), /regular file/)
  }
)
