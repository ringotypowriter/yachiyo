import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'

import { deriveMailboxKeys, sealMailbox } from './noise/mailboxCrypto.ts'
import type { PairingStore } from './pairingStore.ts'

export type ICloudDriveState = 'available' | 'unavailable'

/** iCloud Drive's local root; the same folder `syncReadiness.ts` treats as "available". */
export function defaultICloudDriveRoot(): string {
  return join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
}

export async function detectICloudDrive(root: string): Promise<ICloudDriveState> {
  try {
    await access(root, constants.W_OK)
    return 'available'
  } catch {
    return 'unavailable'
  }
}

export function mailboxDirectory(root: string): string {
  // Next to (not inside) Documents/Yachiyo/Sync, so sync-core never picks these files up.
  return join(root, 'Documents', 'Yachiyo', 'Remote')
}

/**
 * Publishes each pairing's encrypted endpoint list to iCloud Drive so a phone whose tunnel
 * hostname went stale can find the new one. Every write bumps the pairing's counter; the
 * phone rejects any box whose counter is not newer than what it has seen.
 */
export class MailboxWriter {
  private readonly root: string
  private readonly store: PairingStore
  private readonly remoteDeviceId: string
  private readonly now: () => number
  private readonly lastPublished = new Map<string, string>()
  private operationQueue: Promise<unknown> = Promise.resolve()

  constructor(options: {
    root: string
    store: PairingStore
    remoteDeviceId: string
    now?: () => number
  }) {
    this.root = options.root
    this.store = options.store
    this.remoteDeviceId = options.remoteDeviceId
    this.now = options.now ?? Date.now
  }

  /** Writes changed endpoint lists; returns the pairing ids that were written. */
  async publish(endpoints: RemoteEndpoint[], pairingIds?: readonly string[]): Promise<string[]> {
    const snapshot = endpoints.map((endpoint) => ({ ...endpoint }))
    const targets = pairingIds ? [...pairingIds] : undefined
    return this.enqueue(() => this.publishSnapshot(snapshot, targets))
  }

  private async publishSnapshot(
    endpoints: RemoteEndpoint[],
    pairingIds?: readonly string[]
  ): Promise<string[]> {
    if (endpoints.length === 0) return []
    if ((await detectICloudDrive(this.root)) === 'unavailable') return []
    const serialized = JSON.stringify(endpoints)
    const targets = pairingIds ?? (await this.store.list()).map((pairing) => pairing.pairingId)
    const written: string[] = []
    for (const pairingId of targets) {
      if (this.lastPublished.get(pairingId) === serialized) continue
      const { mailboxId, mailboxKey } = deriveMailboxKeys(await this.store.mailboxSecret(pairingId))
      const counter = await this.store.nextMailboxCounter(pairingId)
      const box = sealMailbox(mailboxKey, {
        remoteDeviceId: this.remoteDeviceId,
        endpoints,
        counter,
        issuedAt: new Date(this.now()).toISOString()
      })
      const directory = mailboxDirectory(this.root)
      await mkdir(directory, { recursive: true })
      const path = join(directory, `${mailboxId}.box`)
      await writeFile(`${path}.tmp`, box)
      await rename(`${path}.tmp`, path)
      this.lastPublished.set(pairingId, serialized)
      written.push(pairingId)
    }
    return written
  }

  /** Removes a revoked pairing's box; the secret must be read before the pairing is deleted. */
  async remove(mailboxSecret: Buffer, pairingId: string): Promise<void> {
    const { mailboxId } = deriveMailboxKeys(mailboxSecret)
    await this.enqueue(async () => {
      this.lastPublished.delete(pairingId)
      await rm(join(mailboxDirectory(this.root), `${mailboxId}.box`), { force: true })
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation)
    this.operationQueue = result.catch(() => undefined)
    return result
  }
}
