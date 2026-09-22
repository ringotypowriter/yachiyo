import { REMOTE_ERROR_NAMES } from '@yachiyo/shared/remote/common'
import { handshakeClientPayloadSchema, type PairingGrant } from '@yachiyo/shared/remote/pairing'
import { REMOTE_HANDSHAKE_MODE, REMOTE_NOISE_PROLOGUE } from '@yachiyo/shared/remote/wire'
import type { RpcMessage, RpcTransport } from '@yachiyo/shared/rpc/rpcTransport'

import { HandshakeState } from './noise/handshake.ts'
import { NoiseTransport } from './noise/transport.ts'
import type { DesktopIdentity, PairingRecord, PairingStore } from './pairingStore.ts'
import type { RemoteFacade } from './remoteFacade.ts'
import type { RemoteEventHub, RemoteEventSubscription } from './remoteEventHub.ts'

const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024

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
  facade: RemoteFacade
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

  constructor(socket: RemoteSocket, noise: NoiseTransport) {
    this.socket = socket
    this.noise = noise
  }

  post(message: RpcMessage): void {
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // A phone that stopped reading will resume or resync after reconnecting.
      this.socket.close(REMOTE_CLOSE_CODES.backpressure, 'backpressure')
      return
    }
    this.socket.send(this.noise.encrypt(Buffer.from(JSON.stringify(message), 'utf8')))
  }

  receive(frame: Buffer): void {
    this.deliver(this.noise.decrypt(frame))
  }

  deliver(plaintext: Buffer): void {
    const message = JSON.parse(plaintext.toString('utf8')) as RpcMessage
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
    for (const handler of this.closeHandlers) handler()
  }

  close(): void {
    this.socket.close(1000, 'closed')
  }
}

type State =
  | { kind: 'handshake' }
  | {
      kind: 'pairing'
      transport: EncryptedSocketTransport
      noise: NoiseTransport
      token: Buffer
      phoneKey: Buffer
      deviceName: string
    }
  | {
      kind: 'ready'
      transport: EncryptedSocketTransport
      pairing: PairingRecord
      subscription: RemoteEventSubscription
    }
  | { kind: 'closed' }

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
      this.queue = this.queue
        .then(() => this.handleFrame(Buffer.from(data), isBinary))
        .catch((error: unknown) => {
          this.deps.log(
            `[remote] connection error: ${error instanceof Error ? error.message : String(error)}`
          )
          this.close(REMOTE_CLOSE_CODES.protocolError, 'protocol error')
        })
    })
    socket.on('close', () => this.teardown())
  }

  get pairingId(): string | null {
    return this.state.kind === 'ready' ? this.state.pairing.pairingId : null
  }

  close(code: number, reason: string): void {
    if (this.state.kind === 'closed') return
    this.socket.close(code, reason)
    this.teardown()
  }

  private teardown(): void {
    if (this.state.kind === 'closed') return
    clearTimeout(this.timer)
    if (this.state.kind === 'ready') {
      this.state.subscription.close()
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
        this.state.transport.receive(frame)
        return
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
      handshake.readMessage(message)
      const phoneKey = handshake.remoteStaticKey!
      const pairing = await this.deps.store.findByPhoneKey(phoneKey)
      if (!pairing) {
        this.close(REMOTE_CLOSE_CODES.unknownDevice, 'unknown device')
        return
      }
      this.socket.send(handshake.writeMessage(Buffer.alloc(0)))
      const transport = new EncryptedSocketTransport(
        this.socket,
        new NoiseTransport(handshake.split())
      )
      await this.becomeReady(transport, pairing)
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
      handshake.setPsk(token)
      this.socket.send(handshake.writeMessage(Buffer.alloc(0)))
      const noise = new NoiseTransport(handshake.split())
      this.state = {
        kind: 'pairing',
        noise,
        transport: new EncryptedSocketTransport(this.socket, noise),
        token,
        phoneKey: handshake.remoteStaticKey!,
        deviceName: payload.deviceName
      }
      return
    }

    throw new Error('Unknown handshake mode.')
  }

  private async completePairing(frame: Buffer): Promise<void> {
    if (this.state.kind !== 'pairing') return
    const { noise, transport, token, phoneKey, deviceName } = this.state
    // Decrypting proves the phone derived the same keys from the token; a wrong token throws
    // here and the connection closes before anything is stored.
    const firstMessage = noise.decrypt(frame)
    const { record, mailboxSecret } = await this.deps.store.completePairing({
      token,
      phoneKey,
      deviceName
    })
    this.deps.onPaired?.(record)
    await this.becomeReady(transport, record, {
      type: 'pairing.granted',
      pairingId: record.pairingId,
      mailboxSecret: mailboxSecret.toString('base64url')
    })
    transport.deliver(firstMessage)
  }

  private async becomeReady(
    transport: EncryptedSocketTransport,
    pairing: PairingRecord,
    grant?: PairingGrant
  ): Promise<void> {
    clearTimeout(this.timer)
    const subscription = this.deps
      .hub()
      .attach((push) => transport.post({ kind: 'rpc:event', payload: push }))
    this.state = { kind: 'ready', transport, pairing, subscription }
    if (grant) transport.post({ kind: 'rpc:event', payload: grant })
    transport.onMessage((message) => {
      if (message.kind !== 'rpc:request') return
      const context = { pairingId: pairing.pairingId, subscription }
      this.deps.facade
        .dispatch(context, message.method, message.args[0])
        .then(
          (value) => transport.post({ kind: 'rpc:response', id: message.id, ok: true, value }),
          (error: unknown) =>
            transport.post({
              kind: 'rpc:response',
              id: message.id,
              ok: false,
              error: toWireError(error)
            })
        )
        .catch((error: unknown) => this.deps.log(`[remote] reply failed: ${String(error)}`))
    })
    void this.deps.store.touch(pairing.pairingId)
    this.deps.onReady(this)
  }
}
