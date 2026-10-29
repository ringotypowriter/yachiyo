import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { SecretBox } from '../remote/pairingStore.ts'

const PREFIX = Buffer.from('yachiyo-app-remote-v1\0')

export function isAppServerSecret(bytes: Buffer): boolean {
  return bytes.subarray(0, PREFIX.length).equals(PREFIX)
}

/** Legacy wallet values are unlocked by the shell over the startup pipe, never written in plaintext. */
export function createAppServerSecretBox(
  providerKey: Uint8Array,
  legacy: Readonly<Record<string, string>> = {}
): SecretBox {
  if (providerKey.byteLength !== 32) throw new Error('A 32-byte credential key is required')
  const key = Buffer.from(hkdfSync('sha256', providerKey, PREFIX, 'remote', 32))
  return {
    encrypt(plaintext) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(PREFIX)
      const bytes = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Buffer.concat([PREFIX, nonce, cipher.getAuthTag(), bytes])
    },
    decrypt(envelope) {
      if (!isAppServerSecret(envelope)) {
        const plaintext = legacy[envelope.toString('base64')]
        if (plaintext === undefined)
          throw new Error('Legacy Remote credentials need to be unlocked by the desktop app')
        return Buffer.from(plaintext, 'base64')
      }
      const bytes = envelope.subarray(PREFIX.length)
      if (bytes.length < 28) throw new Error('Invalid Remote credential envelope')
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAAD(PREFIX)
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
    }
  }
}
