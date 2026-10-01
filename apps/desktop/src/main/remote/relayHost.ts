import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'

import type { RemoteSocket } from './remoteConnection.ts'

const MAX_FRAME = 8 * 1024 * 1024 + 1024
const MAX_QUEUE = 16 * 1024 * 1024

/** Only an HTTPS/WSS origin is accepted; paths, userinfo and query strings can leak bearer keys. */
export function relayServerOrigin(input: string): string {
  const url = new URL(input)
  if (
    !['https:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Enter a secure relay server origin.')
  url.protocol = 'https:'
  return url.origin
}

export function relayPhoneEndpoint(
  server: string,
  hostId: string,
  phoneId: string,
  token: string
): {
  kind: 'relay'
  url: string
  token: string
} {
  return {
    kind: 'relay' as const,
    url: `${relayServerOrigin(server).replace(/^https:/, 'wss:')}/v1/phones/${encodeURIComponent(hostId)}/${encodeURIComponent(phoneId)}/ws`,
    token
  }
}

class VirtualSocket extends EventEmitter implements RemoteSocket {
  private closed = false
  readonly id: string
  readonly prefix: Buffer
  private readonly host: RelayHost
  constructor(id: string, prefix: Buffer, host: RelayHost) {
    super()
    this.id = id
    this.prefix = prefix
    this.host = host
  }
  get bufferedAmount(): number {
    return this.host.bufferedAmount
  }
  receive(data: Buffer): void {
    if (!this.closed) this.emit('message', data, true)
  }
  send(data: Buffer): void {
    if (this.closed) return
    if (data.length > MAX_FRAME || this.bufferedAmount + data.length + 16 > MAX_QUEUE) {
      this.close()
      return
    }
    this.host.sendBinary(Buffer.concat([this.prefix, data]))
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.host.remove(this.id, true)
    this.emit('close')
  }
  disconnect(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

export interface RelayHostOptions {
  server: string
  hostId: string
  key: string
  accept(socket: RemoteSocket, phone: string): void
  authorizePhone?(phone: string): boolean
  log(line: string): void
  /** Test-only transport injection; production always uses authenticated WSS. */
  connect?: (url: string, headers: { Authorization: string }) => WebSocket
}

/** One outbound socket carries independently encrypted, per-session RemoteConnection streams. */
export class RelayHost {
  private socket: WebSocket | null = null
  private streams = new Map<string, VirtualSocket>()
  private timer: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private delay = 1000
  private readonly options: RelayHostOptions
  constructor(options: RelayHostOptions) {
    this.options = options
  }
  get bufferedAmount(): number {
    return this.socket?.bufferedAmount ?? MAX_QUEUE
  }
  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  async start(beforeReady?: () => Promise<void>): Promise<void> {
    this.stopped = false
    await this.dial(beforeReady)
  }

  private async dial(beforeReady?: () => Promise<void>): Promise<void> {
    if (this.stopped) return
    const origin = relayServerOrigin(this.options.server)
    const url = `${origin.replace(/^https:/, 'wss:')}/v1/hosts/${encodeURIComponent(this.options.hostId)}/ws`
    const socket =
      this.options.connect?.(url, { Authorization: `Bearer ${this.options.key}` }) ??
      new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.options.key}` },
        perMessageDeflate: false,
        maxPayload: MAX_FRAME + 16
      })
    this.socket = socket
    socket.on('error', () => {
      /* Error text can include a bearer URL from a proxy; do not log it. */
    })
    socket.on('message', (payload, isBinary) => {
      if (socket !== this.socket || !this.connected) return
      if (!isBinary) {
        if (Buffer.byteLength(payload.toString()) > 1024) {
          socket.close(4400, 'invalid control')
          return
        }
        let message: { type?: string; session?: string; phone?: string }
        try {
          message = JSON.parse(payload.toString()) as typeof message
        } catch {
          socket.close(4400, 'invalid control')
          return
        }
        if (
          message.type === 'connect' &&
          typeof message.phone === 'string' &&
          typeof message.session === 'string' &&
          /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(message.session)
        ) {
          if (this.options.authorizePhone && !this.options.authorizePhone(message.phone)) {
            socket.send(JSON.stringify({ type: 'close', session: message.session }))
            return
          }
          const prefix = Buffer.from(message.session.replaceAll('-', ''), 'hex')
          this.streams.get(message.session)?.disconnect()
          const stream = new VirtualSocket(message.session, prefix, this)
          this.streams.set(message.session, stream)
          this.options.accept(stream, message.phone)
          socket.send(JSON.stringify({ type: 'open', session: message.session }))
        } else if (message.type === 'disconnect' && typeof message.session === 'string') {
          this.remove(message.session, false)
        } else if (message.type !== 'pong') socket.close(4400, 'invalid control')
        return
      }
      const frame = Buffer.from(payload as Buffer)
      if (frame.length < 17 || frame.length > MAX_FRAME + 16) {
        socket.close(4409, 'frame limit')
        return
      }
      const hex = frame.subarray(0, 16).toString('hex')
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      this.streams.get(id)?.receive(frame.subarray(16))
    })
    socket.on('close', () => {
      if (socket !== this.socket) return
      this.socket = null
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      for (const stream of this.streams.values()) stream.disconnect()
      this.streams.clear()
      if (!this.stopped) {
        this.retry = setTimeout(() => {
          this.retry = null
          void this.dial(beforeReady).catch(() => this.scheduleRetry(beforeReady))
        }, this.delay)
        this.delay = Math.min(this.delay * 2, 30_000)
      }
    })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
        socket.once('close', () => reject(new Error('Relay socket closed before connecting.')))
      })
      // Restore credentials before announcing the host as available to callers.
      await beforeReady?.()
      if (this.stopped || socket !== this.socket) return
      this.delay = 1000
      this.timer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}')
      }, 30_000)
      this.timer.unref()
    } catch {
      socket.terminate()
      if (!this.stopped && socket !== this.socket) this.scheduleRetry(beforeReady)
    }
  }
  private scheduleRetry(beforeReady?: () => Promise<void>): void {
    if (this.stopped || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      void this.dial(beforeReady)
    }, this.delay)
    this.delay = Math.min(this.delay * 2, 30_000)
  }
  sendBinary(data: Buffer): void {
    if (this.connected) this.socket!.send(data, { binary: true })
  }
  remove(id: string, notify: boolean): void {
    const stream = this.streams.get(id)
    if (!stream) return
    this.streams.delete(id)
    if (notify && this.connected) this.socket!.send(JSON.stringify({ type: 'close', session: id }))
    stream.disconnect()
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    if (this.timer) clearInterval(this.timer)
    this.retry = this.timer = null
    for (const stream of this.streams.values()) stream.disconnect()
    this.streams.clear()
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.close()
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
    }
  }
}
