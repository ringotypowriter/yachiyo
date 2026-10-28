import { isAppServerSecret } from '@yachiyo/runtime/appServer/secretBox'
import { safeStorage } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function unlockLegacyRemoteSecrets(home: string): Promise<Record<string, string>> {
  const secrets: Record<string, string> = Object.create(null)
  const readOptional = async (name: string): Promise<Buffer | null> => {
    try {
      return await readFile(join(home, 'remote', name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const unlock = (bytes: Buffer): void => {
    if (!isAppServerSecret(bytes))
      secrets[bytes.toString('base64')] = safeStorage.decryptString(bytes)
  }
  for (const name of ['identity.bin', 'relay-activation.bin', 'relay-grants.bin']) {
    const bytes = await readOptional(name)
    if (bytes) unlock(bytes)
  }
  const pairings = await readOptional('pairings.json')
  if (pairings) {
    const file = JSON.parse(pairings.toString()) as {
      version: number
      pairings: Record<string, unknown>[]
    }
    if (file.version !== 1 || !Array.isArray(file.pairings))
      throw new Error('Unsupported Remote pairings file')
    for (const pairing of file.pairings) {
      for (const field of ['mailboxSecret', 'relayKey', 'pushToken']) {
        const value = pairing[field]
        if (typeof value === 'string') unlock(Buffer.from(value, 'base64'))
      }
    }
  }
  return secrets
}
