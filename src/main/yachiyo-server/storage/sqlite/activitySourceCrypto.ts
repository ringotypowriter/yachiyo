import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { resolveYachiyoActivitySourceKeyPath } from '../../config/paths.ts'
import type { ActivitySourceEntry } from '../../../../shared/yachiyo/protocol.ts'

export interface ActivitySourcePayload {
  version: 1
  summaryText: string
  entries: ActivitySourceEntry[]
}

export interface EncryptedActivitySourcePayload {
  algorithm: 'aes-256-gcm'
  keyVersion: 1
  nonce: string
  authTag: string
  ciphertext: string
}

export interface ActivitySourceCipher {
  encrypt(payload: ActivitySourcePayload): EncryptedActivitySourcePayload
  decrypt(payload: EncryptedActivitySourcePayload): ActivitySourcePayload
}

interface ActivitySourceCipherOptions {
  keyPath?: string
}

const ALGORITHM = 'aes-256-gcm'
const KEY_VERSION = 1
const KEY_BYTES = 32
const NONCE_BYTES = 12

function readOrCreateKey(keyPath: string): Buffer {
  if (!existsSync(keyPath)) {
    const key = randomBytes(KEY_BYTES)
    mkdirSync(dirname(keyPath), { recursive: true })
    writeFileSync(keyPath, key.toString('base64'), { encoding: 'utf8', mode: 0o600 })
    return key
  }

  const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`Activity source key must be ${KEY_BYTES} bytes`)
  }
  return key
}

export function createActivitySourceCipher(
  options: ActivitySourceCipherOptions = {}
): ActivitySourceCipher {
  const key = readOrCreateKey(options.keyPath ?? resolveYachiyoActivitySourceKeyPath())

  return {
    encrypt(payload) {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv(ALGORITHM, key, nonce)
      const plaintext = JSON.stringify(payload)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const authTag = cipher.getAuthTag()

      return {
        algorithm: ALGORITHM,
        keyVersion: KEY_VERSION,
        nonce: nonce.toString('base64'),
        authTag: authTag.toString('base64'),
        ciphertext: ciphertext.toString('base64')
      }
    },

    decrypt(payload) {
      if (payload.algorithm !== ALGORITHM) {
        throw new Error(`Unsupported activity source encryption algorithm: ${payload.algorithm}`)
      }
      if (payload.keyVersion !== KEY_VERSION) {
        throw new Error(`Unsupported activity source key version: ${payload.keyVersion}`)
      }

      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.nonce, 'base64'))
      decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, 'base64')),
        decipher.final()
      ]).toString('utf8')
      return JSON.parse(plaintext) as ActivitySourcePayload
    }
  }
}
