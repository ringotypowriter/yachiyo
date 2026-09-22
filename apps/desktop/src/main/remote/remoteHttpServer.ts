import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { WebSocketServer, type WebSocket } from 'ws'

import { REMOTE_MAX_MESSAGE_BYTES } from '@yachiyo/shared/remote/methods'
import { REMOTE_WS_PATH } from '@yachiyo/shared/remote/wire'

const PING_INTERVAL_MS = 25_000
// Encrypted frame = plaintext + 16-byte tag; leave room for JSON framing overhead.
const MAX_FRAME_BYTES = REMOTE_MAX_MESSAGE_BYTES + 64 * 1024

export interface RemoteHttpServer {
  readonly port: number
  close(): Promise<void>
}

/**
 * HTTP server that only upgrades `REMOTE_WS_PATH` to a WebSocket; every other request gets a
 * bare 404 so the tunnel hostname reveals nothing. Binds to loopback unless the LAN endpoint
 * is enabled.
 */
export async function startRemoteHttpServer(options: {
  host: string
  port: number
  onConnection(socket: WebSocket): void
}): Promise<RemoteHttpServer> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  server.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0]
    if (path !== REMOTE_WS_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => options.onConnection(ws))
  })

  // Cloudflare drops idle WebSockets after about 100 s; pings keep the tunnel leg alive.
  const alive = new WeakSet<WebSocket>()
  wss.on('connection', (ws) => {
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
  })
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate()
        continue
      }
      alive.delete(ws)
      ws.ping()
    }
  }, PING_INTERVAL_MS)
  pingTimer.unref()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      clearInterval(pingTimer)
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
