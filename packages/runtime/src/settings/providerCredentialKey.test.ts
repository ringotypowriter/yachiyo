import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { unlockProviderCredentialKey, type SafeStorageEncryption } from './providerCredentialKey.ts'

const XOR_MASK = 0xa7

function createSafeStorageEncryption(): SafeStorageEncryption {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) =>
      Buffer.from(Buffer.from(plaintext, 'utf8').map((byte) => byte ^ XOR_MASK)),
    decryptString: (encrypted) =>
      Buffer.from(encrypted.map((byte) => byte ^ XOR_MASK)).toString('utf8')
  }
}

test('provider credential key is wrapped at rest and stable across unlocks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-key-'))
  const keyPath = join(root, 'provider-credentials.key')
  const safeStorage = createSafeStorageEncryption()

  try {
    const created = unlockProviderCredentialKey({ keyPath, safeStorage })
    assert.equal(created.byteLength, 32)

    const wrapped = await readFile(keyPath)
    assert.notEqual(wrapped.toString('utf8').trim(), created.toString('base64'))

    const reopened = unlockProviderCredentialKey({ keyPath, safeStorage })
    assert.deepEqual(reopened, created)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider credential key refuses Electron basic-text encryption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-key-basic-text-'))

  try {
    assert.throws(
      () =>
        unlockProviderCredentialKey({
          keyPath: join(root, 'provider-credentials.key'),
          platform: 'linux',
          safeStorage: {
            ...createSafeStorageEncryption(),
            getSelectedStorageBackend: () => 'basic_text'
          }
        }),
      /secure credential store is unavailable/u
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider credential key only applies the basic-text backend check on Linux', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-key-macos-'))

  try {
    const key = unlockProviderCredentialKey({
      keyPath: join(root, 'provider-credentials.key'),
      platform: 'darwin',
      safeStorage: {
        ...createSafeStorageEncryption(),
        getSelectedStorageBackend: () => 'basic_text'
      }
    })
    assert.equal(key.byteLength, 32)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
