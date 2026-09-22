import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { generateKeyPair, keyPairFromPrivate, type KeyPair } from './noise/primitives.ts'

export const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000

/** Encrypts secrets at rest: Electron `safeStorage` in the app, plaintext in tests. */
export interface SecretBox {
  encrypt(plaintext: Buffer): Buffer
  decrypt(ciphertext: Buffer): Buffer
}

export interface PairingRecord {
  pairingId: string
  deviceName: string
  /** Phone static X25519 public key, base64url. */
  phoneKey: string
  mailboxCounter: number
  createdAt: string
  lastSeenAt?: string
}

interface StoredPairing extends PairingRecord {
  /** `SecretBox`-encrypted mailbox secret, base64. */
  mailboxSecret: string
}

interface PairingsFile {
  version: 1
  pairings: StoredPairing[]
}

export interface PairingOffer {
  token: Buffer
  expiresAt: number
}

export interface DesktopIdentity {
  keyPair: KeyPair
  /** First 16 bytes of SHA-256(desktop public key), hex. Independent of Yachiyo sync. */
  remoteDeviceId: string
}

function toPublicRecord(pairing: StoredPairing): PairingRecord {
  return {
    pairingId: pairing.pairingId,
    deviceName: pairing.deviceName,
    phoneKey: pairing.phoneKey,
    mailboxCounter: pairing.mailboxCounter,
    createdAt: pairing.createdAt,
    ...(pairing.lastSeenAt ? { lastSeenAt: pairing.lastSeenAt } : {})
  }
}

export function remoteDeviceIdFor(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest().subarray(0, 16).toString('hex')
}

/**
 * `<home>/remote/identity.bin` (desktop static key) and `<home>/remote/pairings.json`.
 * Secrets are wrapped by the injected SecretBox; the one-time pairing token only lives in
 * memory and is consumed by the first successful pairing handshake.
 */
export class PairingStore {
  private readonly directory: string
  private readonly secretBox: SecretBox
  private readonly now: () => number
  private identity: DesktopIdentity | null = null
  private pairings: StoredPairing[] | null = null
  private offer: PairingOffer | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: { directory: string; secretBox: SecretBox; now?: () => number }) {
    this.directory = options.directory
    this.secretBox = options.secretBox
    this.now = options.now ?? Date.now
  }

  async loadIdentity(): Promise<DesktopIdentity> {
    if (this.identity) return this.identity
    const path = join(this.directory, 'identity.bin')
    const stored = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    let keyPair: KeyPair
    if (stored) {
      keyPair = keyPairFromPrivate(this.secretBox.decrypt(stored))
    } else {
      keyPair = generateKeyPair()
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await writeFile(path, this.secretBox.encrypt(keyPair.privateKey), { mode: 0o600 })
    }
    this.identity = { keyPair, remoteDeviceId: remoteDeviceIdFor(keyPair.publicKey) }
    return this.identity
  }

  async list(): Promise<PairingRecord[]> {
    return (await this.load()).map(toPublicRecord)
  }

  async findByPhoneKey(phoneKey: Buffer): Promise<PairingRecord | null> {
    const encoded = phoneKey.toString('base64url')
    const match = (await this.load()).find((pairing) => pairing.phoneKey === encoded)
    return match ? toPublicRecord(match) : null
  }

  async mailboxSecret(pairingId: string): Promise<Buffer> {
    const pairing = (await this.load()).find((entry) => entry.pairingId === pairingId)
    if (!pairing) throw new Error('Unknown pairing.')
    return this.secretBox.decrypt(Buffer.from(pairing.mailboxSecret, 'base64'))
  }

  /** Starts a new pairing window; any earlier unused token stops working. */
  createOffer(): PairingOffer {
    this.offer = { token: randomBytes(32), expiresAt: this.now() + PAIRING_TOKEN_TTL_MS }
    return this.offer
  }

  /** The PSK for a pairing handshake, or null when no unexpired offer is open. */
  activeToken(): Buffer | null {
    if (!this.offer || this.offer.expiresAt <= this.now()) return null
    return this.offer.token
  }

  /** Commits a pairing after the phone proved it holds `token`; the token is single-use. */
  async completePairing(input: {
    token: Buffer
    phoneKey: Buffer
    deviceName: string
  }): Promise<{ record: PairingRecord; mailboxSecret: Buffer }> {
    const active = this.activeToken()
    if (!active || active.length !== input.token.length || !timingSafeEqual(active, input.token)) {
      throw new Error('Pairing token is no longer valid.')
    }
    this.offer = null
    const mailboxSecret = randomBytes(32)
    const phoneKey = input.phoneKey.toString('base64url')
    const record: StoredPairing = {
      pairingId: randomUUID(),
      deviceName: input.deviceName.slice(0, 200),
      phoneKey,
      mailboxSecret: this.secretBox.encrypt(mailboxSecret).toString('base64'),
      mailboxCounter: 0,
      createdAt: new Date(this.now()).toISOString()
    }
    await this.mutate((pairings) => [
      // Re-pairing the same phone key replaces the old record.
      ...pairings.filter((pairing) => pairing.phoneKey !== phoneKey),
      record
    ])
    return { record: toPublicRecord(record), mailboxSecret }
  }

  async revoke(pairingId: string): Promise<boolean> {
    let removed = false
    await this.mutate((pairings) =>
      pairings.filter((pairing) => {
        if (pairing.pairingId !== pairingId) return true
        removed = true
        return false
      })
    )
    return removed
  }

  async touch(pairingId: string): Promise<void> {
    const seenAt = new Date(this.now()).toISOString()
    await this.mutate((pairings) =>
      pairings.map((pairing) =>
        pairing.pairingId === pairingId ? { ...pairing, lastSeenAt: seenAt } : pairing
      )
    )
  }

  /** Increments and persists the mailbox counter, returning the new value. */
  async nextMailboxCounter(pairingId: string): Promise<number> {
    let next = 0
    await this.mutate((pairings) =>
      pairings.map((pairing) => {
        if (pairing.pairingId !== pairingId) return pairing
        next = pairing.mailboxCounter + 1
        return { ...pairing, mailboxCounter: next }
      })
    )
    if (next === 0) throw new Error('Unknown pairing.')
    return next
  }

  private async load(): Promise<StoredPairing[]> {
    if (this.pairings) return this.pairings
    const raw = await readFile(join(this.directory, 'pairings.json'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      }
    )
    const parsed = raw ? (JSON.parse(raw) as PairingsFile) : { version: 1, pairings: [] }
    this.pairings = parsed.pairings
    return this.pairings
  }

  private mutate(update: (pairings: StoredPairing[]) => StoredPairing[]): Promise<void> {
    const run = async (): Promise<void> => {
      const next = update(await this.load())
      this.pairings = next
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const path = join(this.directory, 'pairings.json')
      const temp = `${path}.${process.pid}.tmp`
      const file: PairingsFile = { version: 1, pairings: next }
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, path)
    }
    this.writeQueue = this.writeQueue.then(run, run)
    return this.writeQueue
  }
}

export const plaintextSecretBox: SecretBox = {
  encrypt: (plaintext) => Buffer.from(plaintext),
  decrypt: (ciphertext) => Buffer.from(ciphertext)
}
