import WebSocket from 'ws'

import type { RemotePush } from '@yachiyo/shared/remote/events'
import { decodePairingUrl, type PairingGrant } from '@yachiyo/shared/remote/pairing'
import { REMOTE_HANDSHAKE_MODE, REMOTE_NOISE_PROLOGUE } from '@yachiyo/shared/remote/wire'
import type { RpcMessage } from '@yachiyo/shared/rpc/rpcTransport'

import { HandshakeState } from '../noise/handshake.ts'
import { generateKeyPair, type KeyPair } from '../noise/primitives.ts'
import { NoiseTransport } from '../noise/transport.ts'

export class RemoteCallError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Minimal phone-side client for tests and the Node end-to-end script: Noise initiator,
 * encrypted JSON-RPC, and a log of server pushes.
 */
export class RemoteTestClient {
  readonly pushes: RemotePush[] = []
  grant: PairingGrant | null = null
  closeCode: number | null = null
  private readonly socket: WebSocket
  private readonly noise: NoiseTransport
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly waiters: Array<{
    predicate: (push: RemotePush) => boolean
    resolve: (push: RemotePush) => void
  }> = []
  private readonly closeWaiters: Array<(code: number) => void> = []

  private constructor(socket: WebSocket, noise: NoiseTransport) {
    this.socket = socket
    this.noise = noise
    socket.on('message', (data: Buffer) => this.receive(data))
    socket.on('close', (code: number) => {
      this.closeCode = code
      for (const pending of this.pending.values()) {
        pending.reject(new RemoteCallError('ConnectionClosed', `closed with ${code}`))
      }
      this.pending.clear()
      for (const waiter of this.closeWaiters.splice(0)) waiter(code)
    })
  }

  /** Pairs using a QR URL; the grant arrives with the reply to the first call. */
  static async pair(
    pairingUrl: string,
    options: { endpoint?: string; phoneKeyPair?: KeyPair; deviceName?: string } = {}
  ): Promise<{
    client: RemoteTestClient
    phoneKeyPair: KeyPair
    desktopKey: Buffer
    endpoint: string
  }> {
    const payload = decodePairingUrl(pairingUrl)
    const phoneKeyPair = options.phoneKeyPair ?? generateKeyPair()
    const desktopKey = Buffer.from(payload.desktopKey, 'base64url')
    const endpoint = options.endpoint ?? payload.endpoints[0]!.url
    const client = await RemoteTestClient.open(endpoint, {
      mode: 'pair',
      phoneKeyPair,
      desktopKey,
      psk: Buffer.from(payload.token, 'base64url'),
      deviceName: options.deviceName ?? 'Node test phone'
    })
    return { client, phoneKeyPair, desktopKey, endpoint }
  }

  static connect(
    endpoint: string,
    input: { phoneKeyPair: KeyPair; desktopKey: Buffer; deviceName?: string }
  ): Promise<RemoteTestClient> {
    return RemoteTestClient.open(endpoint, {
      mode: 'connect',
      phoneKeyPair: input.phoneKeyPair,
      desktopKey: input.desktopKey,
      deviceName: input.deviceName ?? 'Node test phone'
    })
  }

  private static async open(
    endpoint: string,
    input: {
      mode: 'pair' | 'connect'
      phoneKeyPair: KeyPair
      desktopKey: Buffer
      psk?: Buffer
      deviceName: string
    }
  ): Promise<RemoteTestClient> {
    const socket = new WebSocket(endpoint)
    socket.binaryType = 'nodebuffer'
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
      socket.once('unexpected-response', (_request, response) =>
        reject(new Error(`Unexpected HTTP ${response.statusCode}`))
      )
    })
    const handshake = HandshakeState.initiator({
      pattern: input.mode === 'pair' ? 'IKpsk2' : 'IK',
      prologue: Buffer.from(REMOTE_NOISE_PROLOGUE, 'utf8'),
      staticKeyPair: input.phoneKeyPair,
      remoteStaticKey: input.desktopKey,
      ...(input.psk ? { psk: input.psk } : {})
    })
    const hello = Buffer.from(
      JSON.stringify({ deviceName: input.deviceName, app: 'yachiyo-node-test', version: '1.0.0' })
    )
    const reply = new Promise<Buffer>((resolve, reject) => {
      socket.once('message', (data: Buffer) => resolve(data))
      socket.once('close', (code: number) =>
        reject(new RemoteCallError('HandshakeRejected', String(code)))
      )
    })
    socket.send(
      Buffer.concat([
        Buffer.from([REMOTE_HANDSHAKE_MODE[input.mode]]),
        handshake.writeMessage(hello)
      ])
    )
    handshake.readMessage(await reply)
    return new RemoteTestClient(socket, new NoiseTransport(handshake.split()))
  }

  call<T = unknown>(method: string, input: unknown = {}): Promise<T> {
    const id = this.nextId++
    const message: RpcMessage = { kind: 'rpc:request', id, method, args: [input] }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.socket.send(this.noise.encrypt(Buffer.from(JSON.stringify(message), 'utf8')))
    })
  }

  waitForPush(predicate: (push: RemotePush) => boolean, timeoutMs = 10_000): Promise<RemotePush> {
    const seen = this.pushes.find(predicate)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a push.')), timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (push) => {
          clearTimeout(timer)
          resolve(push)
        }
      })
    })
  }

  waitForClose(): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode)
    return new Promise((resolve) => this.closeWaiters.push(resolve))
  }

  lastSeq(): number {
    return this.pushes.reduce(
      (max, push) => (push.type === 'event' ? Math.max(max, push.seq) : max),
      0
    )
  }

  close(): Promise<number> {
    this.socket.close(1000, 'bye')
    return this.waitForClose()
  }

  private receive(frame: Buffer): void {
    const message = JSON.parse(this.noise.decrypt(frame).toString('utf8')) as RpcMessage
    if (message.kind === 'rpc:response') {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (!pending) return
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new RemoteCallError(message.error.name, message.error.message))
      return
    }
    if (message.kind !== 'rpc:event') return
    const payload = message.payload as RemotePush | PairingGrant
    if (payload.type === 'pairing.granted') {
      this.grant = payload
      return
    }
    this.pushes.push(payload)
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(payload)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(payload)
      }
    }
  }
}
