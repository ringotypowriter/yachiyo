import { REMOTE_ERROR_NAMES } from '@yachiyo/shared/remote/common'
import {
  REMOTE_MAX_MESSAGE_BYTES,
  type HandshakeServerPayload,
  type RemoteMethodOutput
} from '@yachiyo/shared/remote/methods'
import { handshakeClientPayloadSchema, type PairingGrant } from '@yachiyo/shared/remote/pairing'
import {
  REMOTE_COMPRESSION,
  REMOTE_FEATURES,
  REMOTE_HANDSHAKE_MODE,
  REMOTE_NOISE_PROLOGUE,
  type RemoteFeature
} from '@yachiyo/shared/remote/wire'
import type { RpcMessage, RpcTransport } from '@yachiyo/shared/rpc/rpcTransport'

import {
  createStreamDeflateEncoder,
  decodeRemoteMessage,
  encodeRemoteMessage,
  type RemoteCompression,
  type StreamDeflateEncoder
} from './messageCodec.ts'
import { HandshakeState } from './noise/handshake.ts'
import { NoiseTransport } from './noise/transport.ts'
import type { DesktopIdentity, PairingRecord, PairingStore } from './pairingStore.ts'
import type { RemoteFacade } from './remoteFacade.ts'
import type { RemoteEventHub, RemoteEventSubscription } from './remoteEventHub.ts'

const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
const SUPPORTED_FEATURES: readonly RemoteFeature[] = Object.values(REMOTE_FEATURES)

export const REMOTE_CLOSE_CODES = {
  protocolError: 4400,
  unknownDevice: 4401,
  pairingClosed: 4403,
  revoked: 4404,
  backpressure: 4409,
  handshakeTimeout: 4408,
  shuttingDown: 4410
} as const

/** The subset of a `ws` WebSocket the connection uses, so tests can drive it directly. */
export interface RemoteSocket {
  readonly bufferedAmount: number
  send(data: Buffer): void
  close(code: number, reason: string): void
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown
  on(event: 'close', listener: () => void): unknown
}

export interface RemoteConnectionDeps {
  identity: DesktopIdentity
  store: PairingStore
  facade: Pick<RemoteFacade, 'dispatch' | 'hello'>
  /** Returns the running hub, starting it on first use. */
  hub: () => RemoteEventHub
  onReady(connection: RemoteConnection): void
  onPaired?(record: PairingRecord): void
  onClosed(connection: RemoteConnection): void
  log(line: string): void
}

/** `RpcTransport` over one encrypted WebSocket. */
class EncryptedSocketTransport implements RpcTransport {
  private readonly messageHandlers = new Set<(message: RpcMessage) => void>()
  private readonly closeHandlers = new Set<() => void>()
  private readonly socket: RemoteSocket
  private readonly noise: NoiseTransport
  private readonly compression: RemoteCompression
  private readonly deflater: StreamDeflateEncoder | null
  private readonly fail: (code: number, reason: string) => void

  private readonly pending: { plaintext: Buffer; skipCompression: boolean }[] = []
  private queuedBytes = 0
  private draining = false
  private closed = false

  constructor(
    socket: RemoteSocket,
    noise: NoiseTransport,
    options: { compression: RemoteCompression; streamDeflate: boolean },
    fail: (code: number, reason: string) => void
  ) {
    this.socket = socket
    this.noise = noise
    this.compression = options.compression
    this.deflater = options.streamDeflate ? createStreamDeflateEncoder() : null
    this.fail = fail
  }

  post(message: RpcMessage): void {
    if (this.closed) return
    try {
      let plaintext = Buffer.from(JSON.stringify(message), 'utf8')
      if (plaintext.length > REMOTE_MAX_MESSAGE_BYTES && message.kind === 'rpc:response') {
        // Only this call fails; the connection and its other calls stay usable.
        plaintext = Buffer.from(
          JSON.stringify({
            kind: 'rpc:response',
            id: message.id,
            ok: false,
            error: {
              name: 'RemoteLimitExceeded',
              message: 'The response is larger than the remote message limit.'
            }
          } satisfies RpcMessage),
          'utf8'
        )
      }
      if (this.queuedBytes + plaintext.length + this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.fail(REMOTE_CLOSE_CODES.backpressure, 'backpressure')
        return
      }
      const skipCompression =
        message.kind === 'rpc:event' &&
        typeof message.payload === 'object' &&
        message.payload !== null &&
        'type' in message.payload &&
        message.payload.type === 'pairing.granted'
      this.pending.push({ plaintext, skipCompression })
      this.queuedBytes += plaintext.length
      void this.drain()
    } catch {
      this.fail(REMOTE_CLOSE_CODES.protocolError, 'message encoding failed')
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (!this.closed && this.pending.length) {
        const item = this.pending.shift()!
        // The pairing grant carries the mailbox secret: it stays raw and never enters the
        // shared deflate window, where it could shape the size of later messages.
        const envelope =
          this.deflater && !item.skipCompression
            ? await this.deflater.encode(item.plaintext)
            : await encodeRemoteMessage(item.plaintext, this.compression, item)
        if (this.closed) return
        // Include the AEAD tag and all remaining queued plaintext in the budget.
        if (
          this.socket.bufferedAmount +
            this.queuedBytes -
            item.plaintext.length +
            envelope.length +
            16 >
          MAX_BUFFERED_BYTES
        ) {
          this.fail(REMOTE_CLOSE_CODES.backpressure, 'backpressure')
          return
        }
        this.socket.send(this.noise.encrypt(envelope))
        this.queuedBytes -= item.plaintext.length
      }
    } catch {
      this.fail(REMOTE_CLOSE_CODES.protocolError, 'message encoding failed')
    } finally {
      this.draining = false
    }
  }

  async decode(frame: Buffer): Promise<RpcMessage> {
    const plaintext = await decodeRemoteMessage(this.noise.decrypt(frame), this.compression)
    const message = JSON.parse(plaintext.toString('utf8')) as RpcMessage
    if (
      message.kind === 'rpc:request' &&
      (!Number.isSafeInteger(message.id) ||
        typeof message.method !== 'string' ||
        !Array.isArray(message.args))
    ) {
      throw new Error('Invalid remote RPC request.')
    }
    return message
  }

  async receive(frame: Buffer): Promise<void> {
    const message = await this.decode(frame)
    if (!this.closed) this.deliver(message)
  }

  deliver(message: RpcMessage): void {
    if (this.closed) return
    for (const handler of this.messageHandlers) handler(message)
  }

  onMessage(handler: (message: RpcMessage) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  emitClose(): void {
    this.closed = true
    this.pending.length = 0
    this.queuedBytes = 0
    this.deflater?.close()
    for (const handler of this.closeHandlers) handler()
  }

  close(): void {
    this.fail(1000, 'closed')
  }
}

type State =
  | { kind: 'handshake' }
  | {
      kind: 'pairing'
      transport: EncryptedSocketTransport
      token: Buffer
      phoneKey: Buffer
      deviceName: string
      features: ReadonlySet<RemoteFeature>
    }
  | {
      kind: 'ready'
      transport: EncryptedSocketTransport
      pairing: PairingRecord
      subscription: RemoteEventSubscription
    }
  | { kind: 'closed' }

interface HandshakeOffer {
  compression: RemoteCompression
  /** Supported features the phone offered; null when it sent no `features` array at all. */
  features: RemoteFeature[] | null
}

function selectOffer(offer: { compression?: string[]; features?: string[] }): HandshakeOffer {
  return {
    compression: offer.compression?.includes(REMOTE_COMPRESSION) ? REMOTE_COMPRESSION : undefined,
    features: offer.features
      ? SUPPORTED_FEATURES.filter((feature) => offer.features!.includes(feature))
      : null
  }
}

function reconnectOffer(payload: Buffer): HandshakeOffer {
  // Reconnect payloads were historically ignored, including empty and non-JSON bytes, so each
  // field is read on its own and anything malformed counts as not offered.
  let json: unknown
  try {
    json = JSON.parse(payload.toString('utf8'))
  } catch {
    return { compression: undefined, features: null }
  }
  const compression = handshakeClientPayloadSchema.pick({ compression: true }).safeParse(json)
  const features = handshakeClientPayloadSchema.pick({ features: true }).safeParse(json)
  return selectOffer({
    ...(compression.success ? compression.data : {}),
    ...(features.success ? features.data : {})
  })
}

/**
 * Message-2 payload. A phone that offered no `features` gets exactly the original reply (empty,
 * or `{"compression":"gzip"}`), which old phones parse strictly.
 */
function handshakeReply(
  offer: HandshakeOffer,
  enabled: RemoteFeature[],
  hello: RemoteMethodOutput<'remote.hello'> | undefined
): Buffer {
  if (offer.features === null) {
    return offer.compression
      ? Buffer.from(JSON.stringify({ compression: offer.compression }), 'utf8')
      : Buffer.alloc(0)
  }
  const reply: HandshakeServerPayload = {
    ...(offer.compression ? { compression: offer.compression } : {}),
    features: enabled,
    ...(hello ? { hello } : {})
  }
  return Buffer.from(JSON.stringify(reply), 'utf8')
}

function toWireError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : 'Error'
  const message = error instanceof Error ? error.message : String(error)
  return {
    name: (REMOTE_ERROR_NAMES as readonly string[]).includes(name) ? name : 'RemoteInternalError',
    message
  }
}

/**
 * One phone connection: Noise handshake (IK reconnect, or IKpsk2 pairing with the QR token),
 * then encrypted RPC. A pairing only becomes permanent once the phone's first transport frame
 * authenticates, which proves it derived the same keys from the token.
 */
export class RemoteConnection {
  private state: State = { kind: 'handshake' }
  private queue: Promise<void> = Promise.resolve()
  private queuedInboundBytes = 0
  private readonly inbound = new Set<{ frame: Buffer | null }>()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly socket: RemoteSocket
  private readonly deps: RemoteConnectionDeps

  constructor(socket: RemoteSocket, deps: RemoteConnectionDeps) {
    this.socket = socket
    this.deps = deps
    this.timer = setTimeout(() => {
      if (this.state.kind !== 'ready') {
        this.close(REMOTE_CLOSE_CODES.handshakeTimeout, 'handshake timeout')
      }
    }, HANDSHAKE_TIMEOUT_MS)
    socket.on('message', (data, isBinary) => {
      if (this.state.kind === 'closed') return
      if (this.queuedInboundBytes + data.length > MAX_BUFFERED_BYTES) {
        this.close(REMOTE_CLOSE_CODES.backpressure, 'backpressure')
        return
      }
      const entry = { frame: Buffer.from(data) as Buffer | null }
      const bytes = data.length
      this.inbound.add(entry)
      this.queuedInboundBytes += bytes
      this.queue = this.queue
        .then(() => {
          if (this.state.kind !== 'closed' && entry.frame) {
            return this.handleFrame(entry.frame, isBinary)
          }
          return undefined
        })
        .catch((error: unknown) => {
          this.deps.log(
            `[remote] connection error: ${error instanceof Error ? error.message : String(error)}`
          )
          this.close(REMOTE_CLOSE_CODES.protocolError, 'protocol error')
        })
        .finally(() => {
          if (this.inbound.delete(entry)) this.queuedInboundBytes -= bytes
          entry.frame = null
        })
    })
    socket.on('close', () => this.teardown())
  }

  get pairingId(): string | null {
    return this.state.kind === 'ready' ? this.state.pairing.pairingId : null
  }

  private isClosed(): boolean {
    return this.state.kind === 'closed'
  }

  close(code: number, reason: string): void {
    if (this.state.kind === 'closed') return
    this.socket.close(code, reason)
    this.teardown()
  }

  private teardown(): void {
    if (this.state.kind === 'closed') return
    clearTimeout(this.timer)
    for (const entry of this.inbound) entry.frame = null
    this.inbound.clear()
    this.queuedInboundBytes = 0
    if (this.state.kind === 'ready') {
      this.state.subscription.close()
    }
    if (this.state.kind === 'ready' || this.state.kind === 'pairing') {
      this.state.transport.emitClose()
    }
    this.state = { kind: 'closed' }
    this.deps.onClosed(this)
  }

  private async handleFrame(frame: Buffer, isBinary: boolean): Promise<void> {
    if (!isBinary) throw new Error('Text frames are not accepted.')
    switch (this.state.kind) {
      case 'handshake':
        return this.handleHandshake(frame)
      case 'pairing':
        return this.completePairing(frame)
      case 'ready':
        return this.state.transport.receive(frame)
      case 'closed':
        return
    }
  }

  private async handleHandshake(frame: Buffer): Promise<void> {
    const mode = frame[0]
    const message = frame.subarray(1)
    const prologue = Buffer.from(REMOTE_NOISE_PROLOGUE, 'utf8')
    const { keyPair } = this.deps.identity

    if (mode === REMOTE_HANDSHAKE_MODE.connect) {
      const handshake = HandshakeState.responder({
        pattern: 'IK',
        prologue,
        staticKeyPair: keyPair
      })
      const offer = reconnectOffer(handshake.readMessage(message))
      const phoneKey = handshake.remoteStaticKey!
      const pairing = await this.deps.store.findByPhoneKey(phoneKey)
      if (this.state.kind === 'closed') return
      if (!pairing) {
        this.close(REMOTE_CLOSE_CODES.unknownDevice, 'unknown device')
        return
      }
      const { reply, features } = await this.negotiate(offer)
      if (this.isClosed()) return
      this.socket.send(handshake.writeMessage(reply))
      const transport = this.createTransport(handshake, offer, features)
      await this.becomeReady(transport, pairing, features)
      return
    }

    if (mode === REMOTE_HANDSHAKE_MODE.pair) {
      const handshake = HandshakeState.responder({
        pattern: 'IKpsk2',
        prologue,
        staticKeyPair: keyPair
      })
      const payload = handshakeClientPayloadSchema.parse(
        JSON.parse(handshake.readMessage(message).toString('utf8'))
      )
      const token = this.deps.store.activeToken()
      if (!token) {
        this.close(REMOTE_CLOSE_CODES.pairingClosed, 'pairing closed')
        return
      }
      const offer = selectOffer(payload)
      const { reply, features } = await this.negotiate(offer)
      if (this.isClosed()) return
      handshake.setPsk(token)
      this.socket.send(handshake.writeMessage(reply))
      this.state = {
        kind: 'pairing',
        transport: this.createTransport(handshake, offer, features),
        token,
        phoneKey: handshake.remoteStaticKey!,
        deviceName: payload.deviceName,
        features
      }
      return
    }

    throw new Error('Unknown handshake mode.')
  }

  /**
   * Chooses the features to enable. `handshake-hello` is dropped when the hello cannot be
   * built, so the phone falls back to calling `remote.hello` itself.
   */
  private async negotiate(
    offer: HandshakeOffer
  ): Promise<{ reply: Buffer; features: ReadonlySet<RemoteFeature> }> {
    const enabled = [...(offer.features ?? [])]
    let hello: RemoteMethodOutput<'remote.hello'> | undefined
    if (enabled.includes(REMOTE_FEATURES.handshakeHello)) {
      try {
        hello = await this.deps.facade.hello()
      } catch (error) {
        this.deps.log(`[remote] handshake hello unavailable: ${String(error)}`)
        enabled.splice(enabled.indexOf(REMOTE_FEATURES.handshakeHello), 1)
      }
    }
    return { reply: handshakeReply(offer, enabled, hello), features: new Set(enabled) }
  }

  private createTransport(
    handshake: HandshakeState,
    offer: HandshakeOffer,
    features: ReadonlySet<RemoteFeature>
  ): EncryptedSocketTransport {
    return new EncryptedSocketTransport(
      this.socket,
      new NoiseTransport(handshake.split()),
      {
        compression: offer.compression,
        streamDeflate: features.has(REMOTE_FEATURES.streamDeflate)
      },
      (code, reason) => this.close(code, reason)
    )
  }

  private async completePairing(frame: Buffer): Promise<void> {
    if (this.state.kind !== 'pairing') return
    const { transport, token, phoneKey, deviceName, features } = this.state
    // Decrypting proves the phone derived the same keys from the token; a wrong token throws
    // here and the connection closes before anything is stored.
    const firstMessage = await transport.decode(frame)
    if (firstMessage.kind !== 'rpc:request') throw new Error('Expected a pairing RPC request.')
    if (this.state.kind !== 'pairing') return
    const { record, mailboxSecret } = await this.deps.store.completePairing({
      token,
      phoneKey,
      deviceName
    })
    if (this.state.kind !== 'pairing') return
    this.deps.onPaired?.(record)
    await this.becomeReady(transport, record, features, {
      type: 'pairing.granted',
      pairingId: record.pairingId,
      mailboxSecret: mailboxSecret.toString('base64url')
    })
    transport.deliver(firstMessage)
  }

  private async becomeReady(
    transport: EncryptedSocketTransport,
    pairing: PairingRecord,
    features: ReadonlySet<RemoteFeature>,
    grant?: PairingGrant
  ): Promise<void> {
    clearTimeout(this.timer)
    const subscription = this.deps
      .hub()
      .attach((push) => transport.post({ kind: 'rpc:event', payload: push }), {
        batch: features.has(REMOTE_FEATURES.eventBatch)
      })
    this.state = { kind: 'ready', transport, pairing, subscription }
    if (grant) transport.post({ kind: 'rpc:event', payload: grant })
    transport.onMessage((message) => {
      if (message.kind !== 'rpc:request') return
      const context = { pairingId: pairing.pairingId, subscription }
      this.deps.facade
        .dispatch(context, message.method, message.args[0])
        .then(
          (value) =>
            transport.post({
              kind: 'rpc:response',
              id: message.id,
              ok: true,
              value
            }),
          (error: unknown) =>
            transport.post({
              kind: 'rpc:response',
              id: message.id,
              ok: false,
              error: toWireError(error)
            })
        )
        .then(() => {
          // The subscribe response is queued first; the replay and any live events that
          // arrived meanwhile follow it in seq order.
          if (message.method === 'events.subscribe') subscription.startDelivery()
        })
        .catch((error: unknown) => this.deps.log(`[remote] reply failed: ${String(error)}`))
    })
    this.deps.store
      .touch(pairing.pairingId)
      .catch((error: unknown) =>
        this.deps.log(`[remote] could not record last seen: ${String(error)}`)
      )
    this.deps.onReady(this)
  }
}
