import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

import type {
  ProviderCredentialSnapshot,
  ProviderCredentialVault
} from './providerCredentialVault.ts'

const FORMAT_ERROR = 'Plaintext provider credential vault has an unsupported format'

interface PlaintextProviderCredentialEnvelope {
  version: 1
  storage: 'plaintext'
  credentials: ProviderCredentialSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function assertCredentials(value: unknown): asserts value is ProviderCredentialSnapshot {
  if (!isRecord(value)) {
    throw new Error(FORMAT_ERROR)
  }

  for (const [providerId, credentials] of Object.entries(value)) {
    if (
      !providerId.trim() ||
      ['__proto__', 'constructor', 'prototype'].includes(providerId) ||
      !isRecord(credentials) ||
      Object.entries(credentials).some(
        ([key, secret]) =>
          !['apiKey', 'serviceAccountPrivateKey'].includes(key) || typeof secret !== 'string'
      )
    ) {
      throw new Error(FORMAT_ERROR)
    }
  }
}

function parseEnvelope(raw: string): PlaintextProviderCredentialEnvelope {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(FORMAT_ERROR)
  }

  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.version !== 1 ||
    value.storage !== 'plaintext'
  ) {
    throw new Error(FORMAT_ERROR)
  }
  assertCredentials(value.credentials)
  return value as unknown as PlaintextProviderCredentialEnvelope
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function vaultExists(vaultPath: string): boolean {
  try {
    if (!lstatSync(vaultPath).isFile()) {
      throw new Error('Plaintext provider credential vault must be a regular file')
    }
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

/** An explicit plaintext store, independent of the encrypted vault and its key. */
export function createPlaintextProviderCredentialVault(input: {
  vaultPath: string
}): ProviderCredentialVault {
  function read(): ProviderCredentialSnapshot {
    if (!vaultExists(input.vaultPath)) return {}

    const fd = openSync(input.vaultPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return parseEnvelope(readFileSync(fd, 'utf8')).credentials
    } finally {
      closeSync(fd)
    }
  }

  return {
    exists: () => vaultExists(input.vaultPath),
    read,
    write(credentials: ProviderCredentialSnapshot): void {
      assertCredentials(credentials)
      // Refuse to replace malformed/unsupported data, even when called without a prior read.
      read()
      const envelope: PlaintextProviderCredentialEnvelope = {
        version: 1,
        storage: 'plaintext',
        credentials
      }
      const serialized = `${JSON.stringify(envelope)}\n`

      mkdirSync(dirname(input.vaultPath), { recursive: true, mode: 0o700 })
      const temporaryPath = `${input.vaultPath}.${randomUUID()}.tmp`
      const fd = openSync(temporaryPath, 'wx', 0o600)
      try {
        try {
          writeFileSync(fd, serialized)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        renameSync(temporaryPath, input.vaultPath)
      } finally {
        rmSync(temporaryPath, { force: true })
      }
    }
  }
}
