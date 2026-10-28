import { APP_SERVER_PROTOCOL, type AppServerAddress } from '@yachiyo/shared/appServer/protocol'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'
import type { RpcTransport } from '@yachiyo/shared/rpc/rpcTransport'
import {
  createWebSocketRpcTransport,
  RPC_MAX_FRAME_BYTES
} from '@yachiyo/shared/rpc/webSocketRpcTransport'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { AppEventJournal } from './eventJournal.ts'
import { AppHostBridge } from './hostBridge.ts'

export interface AppServerListener {
  address: AppServerAddress
  journal: AppEventJournal
  disconnect(): void
  close(): Promise<void>
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Local owner API. Remote clients continue to use the separately encrypted Remote protocol. */
export async function listenAppServer(options: {
  target: object
  adminTarget?: object
  host: AppHostBridge
  onHostDisconnected?: () => void
  subscribe: (listener: (event: unknown) => void) => () => void
  origins?: string[]
  port?: number
}): Promise<AppServerListener> {
  const instanceId = randomUUID()
  const token = randomBytes(32).toString('base64url')
  const journal = new AppEventJournal(instanceId)
  const unsubscribe = options.subscribe((event) => journal.publish(event))
  const http = createServer((_request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    response.end('Not found')
  })
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: RPC_MAX_FRAME_BYTES,
    perMessageDeflate: false
  })
  let closing = false
  http.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin
    const allowed =
      !origin || origin === 'file://' || origin === 'null' || options.origins?.includes(origin)
    if (closing || request.url !== '/rpc' || !allowed || sockets.clients.size >= 32) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws, request))
  })
  sockets.on('connection', (socket, request) => {
    const transport = createWebSocketRpcTransport(socket)
    const reverse = createRpcClient(transport)
    let role: 'client' | 'admin' | undefined
    let detachHost: (() => void) | undefined
    let detachEvents: (() => void) | undefined
    let activeRequests = 0
    const deadline = setTimeout(() => socket.close(1008, 'Authentication required'), 5000)
    const origin = request.headers.origin ?? ''
    const sign = (payload: string): string =>
      createHmac('sha256', token).update(payload).digest('base64url')
    const target = Object.create(null) as Record<string, unknown>
    target['app.authenticate'] = (input: unknown) => {
      if (role) throw new Error('Already authenticated')
      const auth = z
        .object({ protocol: z.literal(APP_SERVER_PROTOCOL), token: z.string().max(4096) })
        .parse(input)
      if (equalSecret(auth.token, token) && !origin) role = 'admin'
      else {
        const [payload, signature] = auth.token.split('.')
        if (!payload || !signature || !equalSecret(signature, sign(payload)))
          throw new Error('Invalid credentials')
        const claims = z
          .object({ expires: z.number(), origin: z.string() })
          .parse(JSON.parse(Buffer.from(payload, 'base64url').toString()))
        if (claims.expires < Date.now() || claims.origin !== origin)
          throw new Error('Expired or invalid client credentials')
        role = 'client'
      }
      clearTimeout(deadline)
      return { protocol: APP_SERVER_PROTOCOL, instanceId }
    }
    target['app.createClientSession'] = (input: unknown) => {
      if (role !== 'admin') throw new Error('Native host authorization required')
      const { origin } = z.object({ origin: z.string().max(512) }).parse(input)
      const payload = Buffer.from(
        JSON.stringify({ expires: Date.now() + 10 * 60_000, origin })
      ).toString('base64url')
      return { ...address, token: `${payload}.${sign(payload)}` }
    }
    target['app.attachHost'] = () => {
      if (role !== 'admin') throw new Error('Native host authorization required')
      detachHost = options.host.attach(reverse)
      return true
    }
    target['app.detachHost'] = () => {
      if (role !== 'admin') throw new Error('Native host authorization required')
      if (detachHost) {
        detachHost()
        detachHost = undefined
        options.onHostDisconnected?.()
      }
      return true
    }
    target['app.events'] = (input: unknown) => {
      if (!role) throw new Error('Authentication required')
      const cursor = z
        .object({ instanceId: z.string(), sequence: z.number().int().nonnegative() })
        .optional()
        .parse(input)
      detachEvents?.()
      detachEvents = journal.subscribe((frame) => {
        try {
          transport.postEncoded(frame)
        } catch {
          transport.close()
        }
      })
      return journal.replay(cursor)
    }
    // Expose only explicitly registered own methods, never a class prototype or live-object getter.
    for (const [name, method] of Object.entries(options.target)) {
      if (typeof method !== 'function' || name.startsWith('app.'))
        throw new Error(`Invalid app method: ${name}`)
      target[name] = (...args: unknown[]) => {
        if (!role) throw new Error('Authentication required')
        return method(...args)
      }
    }
    for (const [name, method] of Object.entries(options.adminTarget ?? {})) {
      if (typeof method !== 'function' || Object.hasOwn(target, name))
        throw new Error(`Invalid host method: ${name}`)
      target[name] = (...args: unknown[]) => {
        if (role !== 'admin') throw new Error('Native host authorization required')
        return method(...args)
      }
    }
    const bounded: RpcTransport = {
      ...transport,
      post(message) {
        if (message.kind === 'rpc:response') activeRequests--
        transport.post(message)
      },
      onMessage(listener) {
        return transport.onMessage((message) => {
          if (message.kind === 'rpc:request' && ++activeRequests > 128) {
            transport.close()
            return
          }
          listener(message)
        })
      }
    }
    const dispose = serveRpcTarget({ transport: bounded, target })
    let alive = true
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      socket.ping()
    }, 30_000)
    socket.on('pong', () => {
      alive = true
    })
    transport.onClose(() => {
      clearTimeout(deadline)
      clearInterval(heartbeat)
      dispose()
      detachEvents?.()
      detachHost?.()
      if (detachHost) options.onHostDisconnected?.()
    })
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? 0, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const bound = http.address()
  if (!bound || typeof bound === 'string') throw new Error('App server did not bind a TCP port')
  const address: AppServerAddress = {
    protocol: APP_SERVER_PROTOCOL,
    instanceId,
    url: `ws://127.0.0.1:${bound.port}/rpc`,
    token
  }
  return {
    address,
    journal,
    disconnect() {
      closing = true
      for (const socket of sockets.clients) socket.terminate()
    },
    async close() {
      closing = true
      unsubscribe()
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve, reject) =>
        sockets.close((error) => (error ? reject(error) : resolve()))
      )
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}
