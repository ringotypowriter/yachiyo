import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PROVIDER_CREDENTIAL_KEY_BYTES = 32

export interface SafeStorageEncryption {
  isEncryptionAvailable: () => boolean
  encryptString: (plaintext: string) => Buffer
  decryptString: (encrypted: Buffer) => string
  getSelectedStorageBackend?: () => string
}

function decodeProviderCredentialKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64')
  if (key.byteLength !== PROVIDER_CREDENTIAL_KEY_BYTES || key.toString('base64') !== encoded) {
    throw new Error('Provider credential key has an invalid format')
  }
  return key
}

export function unlockProviderCredentialKey(input: {
  keyPath: string
  platform?: NodeJS.Platform
  safeStorage: SafeStorageEncryption
}): Buffer {
  if (
    (input.platform ?? process.platform) === 'linux' &&
    input.safeStorage.getSelectedStorageBackend?.() === 'basic_text'
  ) {
    throw new Error('A secure credential store is unavailable on this system')
  }
  if (!input.safeStorage.isEncryptionAvailable()) {
    throw new Error('System credential encryption is unavailable')
  }

  if (existsSync(input.keyPath)) {
    return decodeProviderCredentialKey(input.safeStorage.decryptString(readFileSync(input.keyPath)))
  }

  const key = randomBytes(PROVIDER_CREDENTIAL_KEY_BYTES)
  const wrapped = input.safeStorage.encryptString(key.toString('base64'))
  mkdirSync(dirname(input.keyPath), { recursive: true })
  writeFileSync(input.keyPath, wrapped, { mode: 0o600 })
  return key
}
