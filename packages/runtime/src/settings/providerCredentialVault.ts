import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const ALGORITHM = 'aes-256-gcm' as const
const ENVELOPE_VERSION = 1
const INITIALIZATION_VECTOR_BYTES = 12
const VAULT_AAD = Buffer.from('yachiyo-provider-credentials:v1')

export interface ProviderCredentials {
  apiKey?: string
  serviceAccountPrivateKey?: string
}

export type ProviderCredentialSnapshot = Record<string, ProviderCredentials>

export interface ProviderCredentialVault {
  exists: () => boolean
  read: () => ProviderCredentialSnapshot
  write: (credentials: ProviderCredentialSnapshot) => void
}

interface ProviderCredentialEnvelope {
  version: 1
  algorithm: 'aes-256-gcm'
  initializationVector: string
  authenticationTag: string
  ciphertext: string
}

function parseEnvelope(raw: string): ProviderCredentialEnvelope {
  const value = JSON.parse(raw) as Partial<ProviderCredentialEnvelope>
  if (
    value.version !== ENVELOPE_VERSION ||
    value.algorithm !== ALGORITHM ||
    typeof value.initializationVector !== 'string' ||
    typeof value.authenticationTag !== 'string' ||
    typeof value.ciphertext !== 'string'
  ) {
    throw new Error('Provider credential vault has an unsupported format')
  }
  return value as ProviderCredentialEnvelope
}

export function createProviderCredentialVault(input: {
  vaultPath: string
  encryptionKey: Uint8Array
}): ProviderCredentialVault {
  const encryptionKey = Buffer.from(input.encryptionKey)
  if (encryptionKey.byteLength !== 32) {
    throw new Error('Provider credential vault requires a 32-byte encryption key')
  }

  return {
    exists(): boolean {
      return existsSync(input.vaultPath)
    },
    read(): ProviderCredentialSnapshot {
      if (!existsSync(input.vaultPath)) {
        return {}
      }

      const envelope = parseEnvelope(readFileSync(input.vaultPath, 'utf8'))
      const decipher = createDecipheriv(
        ALGORITHM,
        encryptionKey,
        Buffer.from(envelope.initializationVector, 'base64')
      )
      decipher.setAAD(VAULT_AAD)
      decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
      ])
      return JSON.parse(plaintext.toString('utf8')) as ProviderCredentialSnapshot
    },
    write(credentials: ProviderCredentialSnapshot): void {
      const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES)
      const cipher = createCipheriv(ALGORITHM, encryptionKey, initializationVector)
      cipher.setAAD(VAULT_AAD)
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(credentials), 'utf8'),
        cipher.final()
      ])
      const envelope: ProviderCredentialEnvelope = {
        version: ENVELOPE_VERSION,
        algorithm: ALGORITHM,
        initializationVector: initializationVector.toString('base64'),
        authenticationTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
      }

      mkdirSync(dirname(input.vaultPath), { recursive: true })
      writeFileSync(input.vaultPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 })
    }
  }
}
