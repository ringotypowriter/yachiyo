import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { z } from 'zod'

import { PROVIDER_BACKUP_MIN_PASSWORD_LENGTH } from '@yachiyo/shared/providerBackup'
import type { ProviderConfig } from '@yachiyo/shared/protocol'

const BACKUP_FORMAT = 'yachiyo.providers.backup' as const
const PAYLOAD_FORMAT = 'yachiyo.providers' as const
const BACKUP_VERSION = 1 as const
const ALGORITHM = 'aes-256-gcm' as const
const KEY_BYTES = 32
const SALT_BYTES = 16
const INITIALIZATION_VECTOR_BYTES = 12
const AUTHENTICATION_TAG_BYTES = 16
const SCRYPT_COST = 32_768
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024
const BACKUP_AAD = Buffer.from(`${BACKUP_FORMAT}:v${BACKUP_VERSION}`)

interface ProviderBackupEnvelope {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  kdf: {
    name: 'scrypt'
    cost: number
    blockSize: number
    parallelization: number
    salt: string
  }
  cipher: {
    name: typeof ALGORITHM
    initializationVector: string
    authenticationTag: string
  }
  ciphertext: string
}

interface ProviderBackupPayload {
  format: typeof PAYLOAD_FORMAT
  version: typeof BACKUP_VERSION
  providers: ProviderConfig[]
}

const reasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
const reasoningSelectionSchema = z.union([z.literal('off'), reasoningEffortSchema])
const providerConfigSchema = z
  .object({
    id: z.string().min(1),
    presetKey: z.string().min(1).optional(),
    name: z.string().refine((value) => value.trim().length > 0),
    type: z.enum([
      'openai',
      'openai-responses',
      'openai-codex',
      'anthropic',
      'gemini',
      'vertex',
      'vercel-gateway'
    ]),
    thinkingEnabled: z.boolean().optional(),
    reasoning: z
      .object({
        defaultEffort: reasoningSelectionSchema.optional(),
        models: z
          .array(
            z
              .object({
                model: z.string(),
                enabled: z.boolean().optional(),
                enabledEfforts: z.array(reasoningEffortSchema).optional(),
                defaultEffort: reasoningSelectionSchema.optional(),
                allowOff: z.boolean().optional()
              })
              .strict()
          )
          .optional()
      })
      .strict()
      .optional(),
    apiKey: z.string(),
    baseUrl: z.string(),
    codexSessionPath: z.string().optional(),
    codexFastMode: z.boolean().optional(),
    project: z.string().optional(),
    location: z.string().optional(),
    serviceAccountEmail: z.string().optional(),
    serviceAccountPrivateKey: z.string().optional(),
    modelList: z
      .object({
        enabled: z.array(z.string()),
        disabled: z.array(z.string()),
        imageIncapable: z.array(z.string()).optional()
      })
      .strict()
  })
  .strict()
const providerListSchema = z.array(providerConfigSchema)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseProviders(value: unknown): ProviderConfig[] {
  const result = providerListSchema.safeParse(value)
  if (!result.success) {
    throw new Error('Provider backup provider data is invalid')
  }

  const ids = new Set<string>()
  const names = new Set<string>()
  for (const provider of result.data) {
    const name = provider.name.trim()
    if ((provider.id && ids.has(provider.id)) || names.has(name)) {
      throw new Error('Provider backup provider data is invalid')
    }
    if (provider.id) ids.add(provider.id)
    names.add(name)
  }

  return result.data
}

function parseEnvelope(serialized: string): ProviderBackupEnvelope {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Provider backup has an unsupported or invalid format')
  }

  if (!isRecord(value) || !isRecord(value['kdf']) || !isRecord(value['cipher'])) {
    throw new Error('Provider backup has an unsupported or invalid format')
  }

  const kdf = value['kdf']
  const cipher = value['cipher']
  if (
    value['format'] !== BACKUP_FORMAT ||
    value['version'] !== BACKUP_VERSION ||
    value['ciphertext'] === '' ||
    typeof value['ciphertext'] !== 'string' ||
    kdf['name'] !== 'scrypt' ||
    kdf['cost'] !== SCRYPT_COST ||
    kdf['blockSize'] !== SCRYPT_BLOCK_SIZE ||
    kdf['parallelization'] !== SCRYPT_PARALLELIZATION ||
    typeof kdf['salt'] !== 'string' ||
    cipher['name'] !== ALGORITHM ||
    typeof cipher['initializationVector'] !== 'string' ||
    typeof cipher['authenticationTag'] !== 'string'
  ) {
    throw new Error('Provider backup has an unsupported or invalid format')
  }

  return value as unknown as ProviderBackupEnvelope
}

function parsePayload(serialized: string): ProviderConfig[] {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Provider backup content is invalid')
  }

  if (
    !isRecord(value) ||
    value['format'] !== PAYLOAD_FORMAT ||
    value['version'] !== BACKUP_VERSION
  ) {
    throw new Error('Provider backup content is invalid')
  }

  return parseProviders(value['providers'])
}

function decodeEnvelopeBytes(value: string, expectedBytes?: number): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (
    decoded.byteLength === 0 ||
    decoded.toString('base64') !== value ||
    (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
  ) {
    throw new Error('Provider backup has an unsupported or invalid format')
  }
  return decoded
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY
      },
      (error, key) => {
        if (error) {
          reject(error)
          return
        }
        resolve(Buffer.from(key))
      }
    )
  })
}

export async function encryptProviderBackup(
  providers: ProviderConfig[],
  password: string
): Promise<string> {
  if (password.length < PROVIDER_BACKUP_MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Provider backup password must contain at least ${PROVIDER_BACKUP_MIN_PASSWORD_LENGTH} characters`
    )
  }

  const validatedProviders = parseProviders(providers)
  const salt = randomBytes(SALT_BYTES)
  const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES)
  const key = await deriveKey(password, salt)
  const cipher = createCipheriv(ALGORITHM, key, initializationVector)
  cipher.setAAD(BACKUP_AAD)
  const payload: ProviderBackupPayload = {
    format: PAYLOAD_FORMAT,
    version: BACKUP_VERSION,
    providers: validatedProviders
  }
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const envelope: ProviderBackupEnvelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kdf: {
      name: 'scrypt',
      cost: SCRYPT_COST,
      blockSize: SCRYPT_BLOCK_SIZE,
      parallelization: SCRYPT_PARALLELIZATION,
      salt: salt.toString('base64')
    },
    cipher: {
      name: ALGORITHM,
      initializationVector: initializationVector.toString('base64'),
      authenticationTag: cipher.getAuthTag().toString('base64')
    },
    ciphertext: ciphertext.toString('base64')
  }

  return `${JSON.stringify(envelope)}\n`
}

export async function decryptProviderBackup(
  serialized: string,
  password: string
): Promise<ProviderConfig[]> {
  const envelope = parseEnvelope(serialized)
  const salt = decodeEnvelopeBytes(envelope.kdf.salt, SALT_BYTES)
  const initializationVector = decodeEnvelopeBytes(
    envelope.cipher.initializationVector,
    INITIALIZATION_VECTOR_BYTES
  )
  const authenticationTag = decodeEnvelopeBytes(
    envelope.cipher.authenticationTag,
    AUTHENTICATION_TAG_BYTES
  )
  const ciphertext = decodeEnvelopeBytes(envelope.ciphertext)
  const key = await deriveKey(password, salt)
  const decipher = createDecipheriv(ALGORITHM, key, initializationVector)
  decipher.setAAD(BACKUP_AAD)
  decipher.setAuthTag(authenticationTag)
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('Provider backup password is incorrect or the file has been modified')
  }
  return parsePayload(plaintext.toString('utf8'))
}

export function mergeProviderBackup(
  existingProviders: ProviderConfig[],
  importedProviders: ProviderConfig[]
): ProviderConfig[] {
  const merged = structuredClone(existingProviders)

  for (const importedProvider of importedProviders) {
    const matchingIdIndex = importedProvider.id
      ? merged.findIndex((provider) => provider.id === importedProvider.id)
      : -1
    const matchingNameIndex = merged.findIndex(
      (provider) => provider.name === importedProvider.name
    )
    if (matchingIdIndex >= 0 && matchingNameIndex >= 0 && matchingIdIndex !== matchingNameIndex) {
      throw new Error(
        `Provider backup has conflicting id and name matches for "${importedProvider.name}"`
      )
    }
    const matchingIndex = matchingIdIndex >= 0 ? matchingIdIndex : matchingNameIndex

    if (matchingIndex < 0) {
      merged.push(structuredClone(importedProvider))
      continue
    }

    const existingProvider = merged[matchingIndex]!
    merged[matchingIndex] = {
      ...structuredClone(importedProvider),
      id: existingProvider.id ?? importedProvider.id,
      name: existingProvider.name
    }
  }

  return merged
}
