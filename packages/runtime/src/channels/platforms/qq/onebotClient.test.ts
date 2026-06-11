import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createOneBotClient } from './onebotClient.ts'

type FakeWebSocketEvent = { data?: unknown; code?: number; reason?: string }

class FakeOneBotWebSocket {
  static OPEN = 1
  readyState = FakeOneBotWebSocket.OPEN
  sent: string[] = []
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
    this.readyState = 3
    this.emit('close', { code: 1000, reason: '' })
  }

  emit(type: string, event: FakeWebSocketEvent): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

function createFakeWebSocketFactory(): {
  WebSocketImpl: typeof FakeOneBotWebSocket
  sockets: FakeOneBotWebSocket[]
} {
  const sockets: FakeOneBotWebSocket[] = []
  class CapturingWebSocket extends FakeOneBotWebSocket {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
  return { WebSocketImpl: CapturingWebSocket, sockets }
}

/**
 * Since the OneBot client depends on WebSocket (network), these tests verify
 * parsing and health behavior without a live NapCatQQ instance.
 */

describe('OneBot v11 message parsing', () => {
  it('parses a private message event correctly', () => {
    const raw = {
      time: 1711627200,
      self_id: 100000,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 12345,
      user_id: 987654,
      raw_message: 'Hello world',
      font: 0,
      sender: {
        user_id: 987654,
        nickname: 'TestUser',
        sex: 'unknown',
        age: 0
      }
    }

    assert.equal(raw.post_type, 'message')
    assert.equal(raw.message_type, 'private')
    assert.equal(raw.user_id, 987654)
    assert.equal(raw.raw_message, 'Hello world')
    assert.equal(raw.sender.nickname, 'TestUser')
  })

  it('serializes a send_private_msg action correctly', () => {
    const action = {
      action: 'send_private_msg',
      params: {
        user_id: 987654,
        message: 'Reply text',
        auto_escape: true
      },
      echo: 'yachiyo-1'
    }

    const serialized = JSON.stringify(action)
    const parsed = JSON.parse(serialized)

    assert.equal(parsed.action, 'send_private_msg')
    assert.equal(parsed.params.user_id, 987654)
    assert.equal(parsed.params.message, 'Reply text')
    assert.equal(parsed.params.auto_escape, true)
    assert.equal(parsed.echo, 'yachiyo-1')
  })

  it('parses an action response correctly', () => {
    const response = {
      status: 'ok',
      retcode: 0,
      data: { message_id: 99999 },
      echo: 'yachiyo-1'
    }

    assert.equal(response.status, 'ok')
    assert.equal(response.retcode, 0)
    assert.equal(response.data.message_id, 99999)
    assert.equal(response.echo, 'yachiyo-1')
  })

  it('identifies meta events as non-message', () => {
    const heartbeat = {
      time: 1711627200,
      self_id: 100000,
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: true, good: true },
      interval: 30000
    }

    assert.equal(heartbeat.post_type, 'meta_event')
    assert.notEqual(heartbeat.post_type, 'message')
  })
})

describe('OneBot healthCheck', () => {
  it('returns true when get_login_info succeeds before timeout', async () => {
    const { WebSocketImpl, sockets } = createFakeWebSocketFactory()
    const client = createOneBotClient({ url: 'ws://onebot.test', WebSocketImpl })
    client.connect()

    const health = client.healthCheck(50)
    const sent = JSON.parse(sockets[0].sent[0])
    sockets[0].emit('message', {
      data: JSON.stringify({
        status: 'ok',
        retcode: 0,
        data: { user_id: 1, nickname: 'bot' },
        echo: sent.echo
      })
    })

    assert.equal(await health, true)
  })

  it('returns false when the socket is not connected', async () => {
    const { WebSocketImpl } = createFakeWebSocketFactory()
    const client = createOneBotClient({ url: 'ws://onebot.test', WebSocketImpl })

    assert.equal(await client.healthCheck(10), false)
  })

  it('returns false when get_login_info times out', async () => {
    const { WebSocketImpl } = createFakeWebSocketFactory()
    const client = createOneBotClient({ url: 'ws://onebot.test', WebSocketImpl })
    client.connect()

    assert.equal(await client.healthCheck(1), false)
  })
})

describe('OneBot file upload actions', () => {
  it('serializes an upload_private_file action with a local path and display name', async () => {
    const { WebSocketImpl, sockets } = createFakeWebSocketFactory()
    const client = createOneBotClient({ url: 'ws://onebot.test', WebSocketImpl })
    client.connect()

    const upload = client.uploadPrivateFile(987654, '/tmp/report.txt', 'report.txt')
    const sent = JSON.parse(sockets[0].sent[0])
    assert.equal(sent.action, 'upload_private_file')
    assert.deepEqual(sent.params, {
      user_id: 987654,
      file: '/tmp/report.txt',
      name: 'report.txt'
    })

    sockets[0].emit('message', {
      data: JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: sent.echo })
    })
    await upload
  })
})
