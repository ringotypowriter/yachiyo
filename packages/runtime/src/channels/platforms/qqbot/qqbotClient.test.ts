import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

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

describe('QQBot C2C file messages', () => {
  it('uploads a local file and sends it as a passive media reply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yachiyo-qqbot-file-'))
    const filePath = join(dir, 'report.txt')
    await writeFile(filePath, 'hello file')

    const calls: Array<{ url: string; method?: string; body?: unknown }> = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      })
      if (url.endsWith('/app/getAppAccessToken')) {
        return jsonResponse({ access_token: 'token', expires_in: 3600 })
      }
      if (url.endsWith('/v2/users/open-1/files')) {
        return jsonResponse({ file_info: 'file-info-1', ttl: 60 })
      }
      return jsonResponse({ id: 'message-1', timestamp: 1711627200 })
    }) as typeof fetch

    const client = createQQBotClient({
      appId: 'app',
      clientSecret: 'secret',
      WebSocketImpl: createFakeWebSocketFactory().WebSocketImpl,
      fetchImpl
    })

    await client.sendC2CFile('open-1', filePath, 'reply-msg-1')
    await client.close()

    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'https://bots.qq.com/app/getAppAccessToken',
        'https://api.sgroup.qq.com/v2/users/open-1/files',
        'https://api.sgroup.qq.com/v2/users/open-1/messages'
      ]
    )
    assert.deepEqual(calls[1].body, {
      file_type: 4,
      srv_send_msg: false,
      file_data: Buffer.from('hello file').toString('base64')
    })
    assert.deepEqual(calls[2].body, {
      msg_type: 7,
      media: { file_info: 'file-info-1' },
      msg_id: 'reply-msg-1',
      msg_seq: 1
    })
  })
})
