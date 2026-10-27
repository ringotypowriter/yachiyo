import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  createProviderCredentialVault,
  type ProviderCredentialVault
} from '@yachiyo/runtime/settings/providerCredentialVault'
import type { SecretBox } from '@yachiyo/runtime/remote/pairingStore'

export function resolveMasterKeyPath(home: string, env = process.env): string {
  if (env.YACHIYO_MASTER_KEY_FILE) return env.YACHIYO_MASTER_KEY_FILE
  if (env.CREDENTIALS_DIRECTORY) return join(env.CREDENTIALS_DIRECTORY, 'yachiyo-master-key')
  return join(home, 'headless-master.key')
}

export function initializeMasterKey(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  readMasterKey(path)
}

export function readMasterKey(path: string): Buffer {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Master key is missing at ${path}. Run yachiyo init or provide YACHIYO_MASTER_KEY_FILE.`
      )
    }
    throw error
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size !== 32) {
      throw new Error(
        'The master key must be a regular 32-byte file readable only by its owner (mode 0600 or 0400).'
      )
    }
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

function deriveKey(master: Uint8Array, purpose: string): Buffer {
  if (master.byteLength !== 32) throw new Error('A 32-byte master key is required')
  return Buffer.from(hkdfSync('sha256', master, 'yachiyo-headless-v1', purpose, 32))
}

export function assertHeadlessDataDirectory(home: string): void {
  if (
    existsSync(join(home, 'provider-credentials.key')) ||
    existsSync(join(home, 'provider-credentials.plaintext.json'))
  ) {
    throw new Error(
      'This data directory uses a desktop wallet. Use a separate YACHIYO_HOME and import a provider backup into headless.'
    )
  }
}

export function createHeadlessProviderVault(
  home: string,
  master: Uint8Array
): ProviderCredentialVault {
  assertHeadlessDataDirectory(home)
  return createProviderCredentialVault({
    vaultPath: join(home, 'provider-credentials.enc'),
    encryptionKey: deriveKey(master, 'providers')
  })
}

/** Domain-separated AES-GCM envelopes for Remote identities and pairing secrets. */
export function createHeadlessSecretBox(master: Uint8Array): SecretBox {
  const key = deriveKey(master, 'remote')
  const aad = Buffer.from('yachiyo-headless-remote-v1')
  return {
    encrypt(plaintext): Buffer {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(aad)
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext])
    },
    decrypt(envelope): Buffer {
      if (envelope.length < 29 || envelope[0] !== 1)
        throw new Error('Unsupported headless Remote secret format')
      const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(1, 13))
      decipher.setAAD(aad)
      decipher.setAuthTag(envelope.subarray(13, 29))
      return Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()])
    }
  }
}
