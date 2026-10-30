import { createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

import { aeadDecrypt, aeadEncrypt, dh, keyPairFromPrivate } from '../remote/noise/primitives.ts'
import type {
  ProviderCredentials,
  ProviderCredentialSnapshot,
  ProviderCredentialVault
} from '../settings/providerCredentialVault.ts'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const KEY_FILE = 'provider-credentials-key.json'
const STATE_FILE = 'provider-credential-sync.json'
const PURPOSE = 'yachiyo-provider-credential-sync:v1'
const deviceIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
const providerIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id))
const counterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const credentialsSchema = z
  .object({
    apiKey: z.string().max(32_768).optional(),
    serviceAccountPrivateKey: z.string().max(32_768).optional()
  })
  .strict()
const credentialsSnapshotSchema = z.record(providerIdSchema, credentialsSchema)
const revisionSchema = z.object({ counter: counterSchema, deviceId: deviceIdSchema }).strict()

function base64Schema(bytes: number): z.ZodString {
  return z.string().refine((value) => {
    const decoded = Buffer.from(value, 'base64')
    return decoded.length === bytes && decoded.toString('base64') === value
  })
}

const peerSchema = z
  .object({
    version: z.literal(1),
    universeId: z.string().min(1).max(128),
    deviceId: deviceIdSchema,
    publicKey: base64Schema(32)
  })
  .strict()
const envelopeSchema = z
  .object({
    version: z.literal(1),
    universeId: z.string(),
    senderDeviceId: deviceIdSchema,
    recipientDeviceId: deviceIdSchema,
    senderPublicKey: base64Schema(32),
    recipientPublicKey: base64Schema(32),
    nonce: base64Schema(12),
    ciphertext: z.string().min(24).max(MAX_FILE_BYTES)
  })
  .strict()
const snapshotSchema = z
  .object({
    version: z.literal(1),
    entries: z.record(
      providerIdSchema,
      z.object({ revision: revisionSchema, credentials: credentialsSchema }).strict()
    )
  })
  .strict()
const stateSchema = z
  .object({
    version: z.literal(1),
    universeId: z.string(),
    deviceId: deviceIdSchema,
    clock: counterSchema,
    peers: z.record(deviceIdSchema, base64Schema(32)),
    entries: z.record(
      providerIdSchema,
      z.object({ revision: revisionSchema, fingerprint: hashSchema }).strict()
    ),
    sent: z.record(
      deviceIdSchema,
      z.object({ payloadHash: hashSchema, contentHash: hashSchema }).strict()
    )
  })
  .strict()

type Peer = z.infer<typeof peerSchema>
type Envelope = z.infer<typeof envelopeSchema>
type Revision = z.infer<typeof revisionSchema>
type SyncState = z.infer<typeof stateSchema>

interface ProviderCredentialSyncInput {
  home: string
  syncDir: string
  deviceId: string
  providerIds: string[]
  vault: ProviderCredentialVault
  apply: (credentials: ProviderCredentialSnapshot) => void
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error('Provider credential sync data has an unsupported format')
  return result.data
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Parser errors can contain input excerpts, including decrypted credentials.
    throw new Error('Provider credential sync data is not valid JSON')
  }
}

function readText(path: string): string | undefined {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new Error('Provider credential sync requires a regular file smaller than 2 MiB')
    }
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function writeText(path: string, text: string): void {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
    throw new Error('Provider credential sync data exceeds 2 MiB')
  }
  if (readText(path) === text) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeCredentials(value: ProviderCredentials): ProviderCredentials {
  const apiKey = value.apiKey?.trim()
  const serviceAccountPrivateKey = value.serviceAccountPrivateKey?.trim()
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(serviceAccountPrivateKey ? { serviceAccountPrivateKey } : {})
  }
}

function fingerprint(credentials: ProviderCredentials): string {
  return hash(
    JSON.stringify([credentials.apiKey ?? '', credentials.serviceAccountPrivateKey ?? ''])
  )
}

function compareRevision(left: Revision, right: Revision): number {
  if (left.counter !== right.counter) return left.counter - right.counter
  return left.deviceId === right.deviceId ? 0 : left.deviceId < right.deviceId ? -1 : 1
}

function context(envelope: Omit<Envelope, 'nonce' | 'ciphertext'>): Buffer {
  return Buffer.from(
    JSON.stringify([
      PURPOSE,
      envelope.version,
      envelope.universeId,
      envelope.senderDeviceId,
      envelope.recipientDeviceId,
      envelope.senderPublicKey,
      envelope.recipientPublicKey
    ])
  )
}

function agreedKey(privateKey: Buffer, publicKey: string, aad: Buffer): Buffer {
  const shared = dh(keyPairFromPrivate(privateKey), Buffer.from(publicKey, 'base64'))
  return Buffer.from(hkdfSync('sha256', shared, aad, PURPOSE, 32))
}

function peers(syncDir: string, local: Peer, state: SyncState): Peer[] {
  const result: Peer[] = []
  const devices = join(syncDir, 'devices')
  for (const entry of readdirSync(devices, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === local.deviceId) continue
    if (!deviceIdSchema.safeParse(entry.name).success) continue
    const manifest = readText(join(devices, entry.name, 'manifest.json'))
    const publicKey = readText(join(devices, entry.name, KEY_FILE))
    // File sync can deliver a device directory before its manifest or public key.
    if (manifest === undefined || publicKey === undefined) continue
    const registered = parse(z.object({ deviceId: deviceIdSchema }), parseJson(manifest))
    const peer = parse(peerSchema, parseJson(publicKey))
    if (
      registered.deviceId !== entry.name ||
      peer.deviceId !== entry.name ||
      peer.universeId !== local.universeId
    ) {
      throw new Error('Provider credential sync device identity does not match its directory')
    }
    const pinned = state.peers[peer.deviceId]
    if (pinned !== undefined && pinned !== peer.publicKey) {
      throw new Error(`Provider credential sync public key changed for device ${peer.deviceId}`)
    }
    state.peers[peer.deviceId] = peer.publicKey
    result.push(peer)
  }
  return result
}

function observeLocal(
  input: ProviderCredentialSyncInput,
  state: SyncState,
  credentials: ProviderCredentialSnapshot
): void {
  for (const providerId of new Set([...input.providerIds, ...Object.keys(state.entries)])) {
    parse(providerIdSchema, providerId)
    const value = normalizeCredentials(credentials[providerId] ?? {})
    const previous = state.entries[providerId]
    if (!previous && Object.keys(value).length === 0) continue
    const currentFingerprint = fingerprint(value)
    if (previous?.fingerprint === currentFingerprint) continue
    if (state.clock === Number.MAX_SAFE_INTEGER) throw new Error('Provider sync clock is exhausted')
    state.clock += 1
    state.entries[providerId] = {
      revision: { counter: state.clock, deviceId: input.deviceId },
      fingerprint: currentFingerprint
    }
  }
}

/**
 * Exchanges public keys and encrypted credential snapshots with joined devices.
 * The selected private sync folder establishes initial device trust; keys are pinned
 * afterward. Synchronous execution keeps local settings edits outside this cycle.
 */
export function syncProviderCredentials(input: ProviderCredentialSyncInput): boolean {
  parse(deviceIdSchema, input.deviceId)
  const universeText = readText(join(input.syncDir, 'universe.json'))
  if (universeText === undefined) throw new Error('Provider credential sync is not initialized')
  const { universeId } = parse(
    z.object({ universeId: z.string().min(1).max(128) }),
    parseJson(universeText)
  )
  const statePath = join(input.home, STATE_FILE)
  const storedState = readText(statePath)
  const state: SyncState =
    storedState === undefined
      ? {
          version: 1,
          universeId,
          deviceId: input.deviceId,
          clock: 0,
          peers: {},
          entries: {},
          sent: {}
        }
      : parse(stateSchema, parseJson(storedState))
  if (state.universeId !== universeId || state.deviceId !== input.deviceId) {
    throw new Error('Provider credential sync state belongs to another device or sync universe')
  }
  if (Object.values(state.entries).some(({ revision }) => revision.counter > state.clock)) {
    throw new Error('Provider credential sync clock is behind its recorded revisions')
  }
  const privateKey = input.vault.deriveSyncKey(universeId)
  const local: Peer = {
    version: 1,
    universeId,
    deviceId: input.deviceId,
    publicKey: keyPairFromPrivate(privateKey).publicKey.toString('base64')
  }
  const deviceDir = join(input.syncDir, 'devices', input.deviceId)
  const manifest = readText(join(deviceDir, 'manifest.json'))
  if (
    manifest === undefined ||
    parse(z.object({ deviceId: deviceIdSchema }), parseJson(manifest)).deviceId !== input.deviceId
  ) {
    throw new Error('Provider credential sync device has not joined this sync folder')
  }
  const ownKeyPath = join(deviceDir, KEY_FILE)
  const previousKey = readText(ownKeyPath)
  if (
    previousKey !== undefined &&
    !isDeepStrictEqual(parse(peerSchema, parseJson(previousKey)), local)
  ) {
    throw new Error('Provider credential sync public key changed for this device')
  }
  writeText(ownKeyPath, JSON.stringify(local))
  const remotePeers = peers(input.syncDir, local, state)
  const originalCredentials = parse(credentialsSnapshotSchema, input.vault.read())
  const credentials = Object.fromEntries(
    Object.entries(originalCredentials).map(([id, value]) => [id, normalizeCredentials(value)])
  )
  observeLocal(input, state, credentials)

  for (const peer of remotePeers) {
    const incoming = readText(
      join(
        input.syncDir,
        'devices',
        peer.deviceId,
        'provider-credentials',
        `${input.deviceId}.json`
      )
    )
    if (incoming === undefined) continue
    const envelope = parse(envelopeSchema, parseJson(incoming))
    if (
      envelope.universeId !== universeId ||
      envelope.senderDeviceId !== peer.deviceId ||
      envelope.recipientDeviceId !== local.deviceId ||
      envelope.senderPublicKey !== peer.publicKey ||
      envelope.recipientPublicKey !== local.publicKey
    ) {
      throw new Error(
        'Encrypted provider credentials are addressed to another device or sync universe'
      )
    }
    const aad = context(envelope)
    const plaintext = aeadDecrypt(
      agreedKey(privateKey, peer.publicKey, aad),
      Buffer.from(envelope.nonce, 'base64'),
      aad,
      Buffer.from(envelope.ciphertext, 'base64')
    )
    const snapshot = parse(snapshotSchema, parseJson(plaintext.toString('utf8')))
    for (const [providerId, incomingEntry] of Object.entries(snapshot.entries)) {
      state.clock = Math.max(state.clock, incomingEntry.revision.counter)
      const value = normalizeCredentials(incomingEntry.credentials)
      const currentFingerprint = fingerprint(value)
      const previous = state.entries[providerId]
      const comparison = previous ? compareRevision(incomingEntry.revision, previous.revision) : 1
      if (comparison === 0 && previous.fingerprint !== currentFingerprint) {
        throw new Error('Provider credential revision contains conflicting values')
      }
      if (comparison <= 0) continue
      if (Object.keys(value).length === 0) delete credentials[providerId]
      else credentials[providerId] = value
      state.entries[providerId] = {
        revision: incomingEntry.revision,
        fingerprint: currentFingerprint
      }
    }
  }

  const changed = !isDeepStrictEqual(originalCredentials, credentials)
  if (changed) input.apply(credentials)
  // Reserve revisions before publishing. A crash must never reuse a sent revision
  // for another value; credential writes must succeed before acknowledging imports.
  writeText(statePath, JSON.stringify(state))
  const payload = JSON.stringify({
    version: 1,
    entries: Object.fromEntries(
      Object.keys(state.entries)
        .sort()
        .map((id) => [
          id,
          { revision: state.entries[id].revision, credentials: credentials[id] ?? {} }
        ])
    )
  })
  for (const peer of remotePeers) {
    const path = join(deviceDir, 'provider-credentials', `${peer.deviceId}.json`)
    const payloadHash = hash(JSON.stringify([local.publicKey, peer.publicKey, payload]))
    const previous = state.sent[peer.deviceId]
    const published = readText(path)
    if (
      previous?.payloadHash === payloadHash &&
      published !== undefined &&
      hash(published) === previous.contentHash
    ) {
      continue
    }
    const header = {
      version: 1 as const,
      universeId,
      senderDeviceId: local.deviceId,
      recipientDeviceId: peer.deviceId,
      senderPublicKey: local.publicKey,
      recipientPublicKey: peer.publicKey
    }
    const aad = context(header)
    const nonce = randomBytes(12)
    const content = JSON.stringify({
      ...header,
      nonce: nonce.toString('base64'),
      ciphertext: aeadEncrypt(
        agreedKey(privateKey, peer.publicKey, aad),
        nonce,
        aad,
        Buffer.from(payload)
      ).toString('base64')
    })
    writeText(path, content)
    state.sent[peer.deviceId] = { payloadHash, contentHash: hash(content) }
  }
  writeText(statePath, JSON.stringify(state))
  return changed
}
