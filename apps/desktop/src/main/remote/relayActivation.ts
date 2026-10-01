import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SecretBox } from './pairingStore.ts'
import { relayServerOrigin } from './relayHost.ts'

export interface RelayCredential {
  server: string
  hostId: string
  key: string
}

/** Invitations are never stored; only the SecretBox-wrapped host credential survives restart. */
export class RelayActivation {
  private readonly path: string
  private readonly directory: string
  private readonly secretBox: SecretBox
  private readonly fetchImpl: typeof fetch
  constructor(directory: string, secretBox: SecretBox, fetchImpl: typeof fetch = fetch) {
    this.directory = directory
    this.secretBox = secretBox
    this.fetchImpl = fetchImpl
    this.path = join(directory, 'relay-activation.bin')
  }
  async load(): Promise<RelayCredential | null> {
    const bytes = await readFile(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!bytes) return null
    const value = JSON.parse(this.secretBox.decrypt(bytes).toString('utf8')) as RelayCredential
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(value.key) || !/^[A-Za-z0-9_-]{1,48}$/.test(value.hostId)) {
      throw new Error('Stored relay activation is invalid.')
    }
    relayServerOrigin(value.server)
    return value
  }
  async redeem(server: string, code: string): Promise<{ hostId: string }> {
    const origin = relayServerOrigin(server)
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Enter a valid invitation code.')
    const response = await this.fetchImpl(`${origin}/v1/invitations/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error('Relay invitation could not be redeemed.')
    const value: unknown = await response.json()
    if (
      !value ||
      typeof value !== 'object' ||
      !('hostId' in value) ||
      typeof value.hostId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,48}$/.test(value.hostId) ||
      !('key' in value) ||
      typeof value.key !== 'string' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(value.key)
    )
      throw new Error('Relay activation response is invalid.')
    const credential: RelayCredential = { server: origin, hostId: value.hostId, key: value.key }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, this.secretBox.encrypt(Buffer.from(JSON.stringify(credential))), {
      mode: 0o600
    })
    await rename(temp, this.path)
    return { hostId: credential.hostId }
  }
}
