import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createProviderCredentialVault } from './providerCredentialVault.ts'

test('provider credential vault round-trips credentials without storing plaintext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-credentials-'))
  const vaultPath = join(root, 'provider-credentials.enc')
  const credentials = {
    'provider-work': {
      apiKey: 'sk-live-provider-secret',
      serviceAccountPrivateKey:
        '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----'
    }
  }
  const vault = createProviderCredentialVault({
    vaultPath,
    encryptionKey: Buffer.alloc(32, 0x5a)
  })

  try {
    vault.write(credentials)

    assert.deepEqual(vault.read(), credentials)

    const persisted = await readFile(vaultPath)
    assert.equal(persisted.includes(Buffer.from(credentials['provider-work'].apiKey)), false)
    assert.equal(
      persisted.includes(Buffer.from(credentials['provider-work'].serviceAccountPrivateKey)),
      false
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
