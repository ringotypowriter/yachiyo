import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createQQBotClient } from './qqbotClient.ts'

type FakeWebSocketEvent = { data?: unknown; code?: number }

class FakeQQBotWebSocket {
  static OPEN = 1
  static CLOSED = 3
  readyState = FakeQQBotWebSocket.OPEN
  sent: string[] = []
  closeCount = 0
  listeners = new Map<string, Array<(event: FakeWebSocketEvent) => void>>()
  url: string

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, handler: (event: FakeWebSocketEvent) => void): void {
    const handlers = this.listeners.get(type) ?? []
    handlers.push(handler)
    this.listeners.set(type, handlers)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closeCount++
    this.readyState = FakeQQBotWebSocket.CLOSED
    this.emit('close', { code: 1000 })
  }

  emit(type: string, event: FakeWebSocketEvent): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

function createFakeWebSocketFactory(): {
  WebSocketImpl: typeof FakeQQBotWebSocket
  sockets: FakeQQBotWebSocket[]
} {
  const sockets: FakeQQBotWebSocket[] = []
  class CapturingWebSocket extends FakeQQBotWebSocket {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
  return { WebSocketImpl: CapturingWebSocket, sockets }
}

function createFetchImpl(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body =
      init?.method === 'POST'
        ? { access_token: 'token', expires_in: 3600 }
        : { url: 'wss://gateway.test' }
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as unknown as Response
  }) as typeof fetch
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('QQBot gateway heartbeat health', () => {
  it('closes a stale socket when heartbeat ACK is not received', async () => {
    const { WebSocketImpl, sockets } = createFakeWebSocketFactory()
    const client = createQQBotClient({
      appId: 'app',
      clientSecret: 'secret',
      WebSocketImpl,
      fetchImpl: createFetchImpl(),
      heartbeatAckTimeoutMs: 8,
      reconnectDelaysMs: [1]
    })

    client.connect()
    await wait(1)
    sockets[0].emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 4 } }) })
    await wait(20)

    assert.equal(sockets[0].closeCount, 1)
    await wait(5)
    assert.equal(sockets.length, 2)
    await client.close()
  })

  it('keeps the socket healthy when heartbeat ACKs arrive', async () => {
    const { WebSocketImpl, sockets } = createFakeWebSocketFactory()
    const client = createQQBotClient({
      appId: 'app',
      clientSecret: 'secret',
      WebSocketImpl,
      fetchImpl: createFetchImpl(),
      heartbeatAckTimeoutMs: 20,
      reconnectDelaysMs: [1]
    })

    client.connect()
    await wait(1)
    sockets[0].emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 5 } }) })
    sockets[0].emit('message', {
      data: JSON.stringify({ op: 0, t: 'READY', d: { session_id: 's1' } })
    })
    await wait(8)
    sockets[0].emit('message', { data: JSON.stringify({ op: 11 }) })
    await wait(8)

    assert.equal(sockets[0].closeCount, 0)
    assert.equal(await client.healthCheck(), true)
    await client.close()
  })

  it('reports unhealthy before ready or after heartbeat ACK stales', async () => {
    const { WebSocketImpl, sockets } = createFakeWebSocketFactory()
    const client = createQQBotClient({
      appId: 'app',
      clientSecret: 'secret',
      WebSocketImpl,
      fetchImpl: createFetchImpl(),
      heartbeatAckTimeoutMs: 8,
      reconnectDelaysMs: [1]
    })

    assert.equal(await client.healthCheck(), false)
    client.connect()
    await wait(1)
    sockets[0].emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 4 } }) })
    assert.equal(await client.healthCheck(), false)
    sockets[0].emit('message', {
      data: JSON.stringify({ op: 0, t: 'READY', d: { session_id: 's1' } })
    })
    sockets[0].emit('message', { data: JSON.stringify({ op: 11 }) })
    assert.equal(await client.healthCheck(), true)
    await wait(12)
    assert.equal(await client.healthCheck(), false)
    await client.close()
  })
})
