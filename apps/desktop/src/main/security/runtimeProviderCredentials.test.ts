import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeProviderCredentialVault } from './runtimeProviderCredentials.ts'

test('runtime rejects missing or contradictory storage modes', () => {
  for (const message of [
    {},
    { providerCredentialKey: new Uint8Array(32) },
    { providerCredentialMode: 'basic' },
    { providerCredentialMode: 'encrypted' },
    { providerCredentialMode: 'plaintext', providerCredentialKey: new Uint8Array(32) }
  ]) {
    assert.throws(() => createRuntimeProviderCredentialVault(message))
  }
})

test('plaintext runtime leaves existing encrypted credentials byte-for-byte intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yachiyo-storage-mode-'))
  try {
    const encrypted = createRuntimeProviderCredentialVault(
      { providerCredentialMode: 'encrypted', providerCredentialKey: new Uint8Array(32).fill(7) },
      dir
    )
    encrypted.write({ old: { apiKey: 'nonsecret-encrypted-fixture' } })
    const original = readFileSync(join(dir, 'provider-credentials.enc'))
    const plaintext = createRuntimeProviderCredentialVault(
      { providerCredentialMode: 'plaintext' },
      dir
    )
    assert.deepEqual(plaintext.read(), {})
    plaintext.write({ other: { apiKey: 'nonsecret-plaintext-fixture' } })
    assert.deepEqual(readFileSync(join(dir, 'provider-credentials.enc')), original)
    assert.deepEqual(encrypted.read(), { old: { apiKey: 'nonsecret-encrypted-fixture' } })
    assert.deepEqual(plaintext.read(), { other: { apiKey: 'nonsecret-plaintext-fixture' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
