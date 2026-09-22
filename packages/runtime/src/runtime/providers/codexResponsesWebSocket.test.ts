import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import test from 'node:test'

import { WebSocketServer, type WebSocket } from 'ws'

import { CodexWebSocketPool, createCodexWebSocketFetch } from './codexResponsesWebSocket.ts'

const HTTP_URL = 'https://chatgpt.com/backend-api/codex/responses'

interface Frame {
  type?: string
  model?: string
  client_metadata?: Record<string, string>
  [key: string]: unknown
}

interface TestServer {
  url: string
  handshakes: IncomingMessage[]
  frames: Frame[]
  sockets: WebSocket[]
  close(): Promise<void>
}

function event(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra })
}

async function startServer(
  onFrame: (socket: WebSocket, frame: Frame, index: number) => void,
  options: { rejectHandshake?: boolean; handshakeHeaders?: string[] } = {}
): Promise<TestServer> {
  const handshakes: IncomingMessage[] = []
  const frames: Frame[] = []
  const sockets: WebSocket[] = []
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (info, done) => {
      handshakes.push(info.req)
      done(!options.rejectHandshake, 403, 'rejected')
    }
  })
  wss.on('headers', (headers) => {
    headers.push(...(options.handshakeHeaders ?? []))
  })
  wss.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame
      frames.push(frame)
      onFrame(socket, frame, frames.length - 1)
    })
  })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  if (typeof address !== 'object' || !address) throw new Error('no address')
  return {
    url: `ws://127.0.0.1:${address.port}/responses`,
    handshakes,
    frames,
    sockets,
    close: () =>
      new Promise((resolve) => {
        for (const socket of wss.clients) socket.terminate()
        wss.close(() => resolve())
      })
  }
}

function unusedFetch(): typeof globalThis.fetch {
  return async () => {
    throw new Error('HTTP fetch should not be used')
  }
}

function recordingFetch(calls: string[]): typeof globalThis.fetch {
  return async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return new Response('http-fallback', { status: 200 })
  }
}

function post(body: Record<string, unknown>, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer token-1',
      'chatgpt-account-id': 'acct_1',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  }
}

test('tunnels /responses POSTs over one pooled websocket and replays events as SSE', async () => {
  const server = await startServer((socket, _frame, index) => {
    socket.send(event('response.created', { response: { id: `resp_${index}` } }))
    socket.send(event('codex.rate_limits', { rate_limits: {} }))
    socket.send(event('response.output_text.delta', { delta: 'ok' }))
    socket.send(event('response.completed', { response: { id: `resp_${index}`, usage: {} } }))
  })
  const pool = new CodexWebSocketPool()
  const fetch = createCodexWebSocketFetch(unusedFetch(), {
    sessionId: 'thread-1',
    pool,
    webSocketUrl: server.url
  })

  try {
    const first = await fetch(HTTP_URL, post({ model: 'gpt-test', input: [], stream: true }))
    assert.equal(first.headers.get('content-type'), 'text/event-stream')
    const firstBody = await first.text()
    const lines = firstBody.split('\n\n').filter(Boolean)
    assert.equal(lines.length, 4)
    assert.ok(lines[0].startsWith('data: {"type":"response.created"'))
    assert.ok(lines[3].startsWith('data: {"type":"response.completed"'))

    const second = await fetch(HTTP_URL, post({ model: 'gpt-test', input: [], stream: true }))
    await second.text()

    assert.equal(server.handshakes.length, 1, 'both requests share one connection')
    assert.equal(server.frames.length, 2)
    assert.equal(server.frames[0].type, 'response.create')
    assert.equal(server.frames[0].model, 'gpt-test')
    assert.equal(server.frames[0].stream, true)
    assert.deepEqual(server.frames[0].client_metadata, {
      session_id: 'thread-1',
      thread_id: 'thread-1'
    })

    const handshake = server.handshakes[0].headers
    assert.equal(handshake['authorization'], 'Bearer token-1')
    assert.equal(handshake['chatgpt-account-id'], 'acct_1')
    assert.equal(handshake['openai-beta'], 'responses_websockets=2026-02-06')
    assert.equal(handshake['session-id'], 'thread-1')
    assert.equal(handshake['thread-id'], 'thread-1')
    assert.equal(handshake['content-type'], undefined)
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('replays the newest x-codex-turn-state on later requests', async () => {
  const server = await startServer(
    (socket) => {
      socket.send(
        event('response.metadata', { headers: { 'x-codex-turn-state': 'state-from-event' } })
      )
      socket.send(event('response.completed', { response: {} }))
    },
    { handshakeHeaders: ['x-codex-turn-state: state-from-handshake'] }
  )
  const pool = new CodexWebSocketPool()
  const fetch = createCodexWebSocketFetch(unusedFetch(), {
    sessionId: 'thread-2',
    pool,
    webSocketUrl: server.url
  })

  try {
    await (await fetch(HTTP_URL, post({ model: 'gpt-test' }))).text()
    await (await fetch(HTTP_URL, post({ model: 'gpt-test' }))).text()

    assert.equal(server.frames[0].client_metadata?.['x-codex-turn-state'], 'state-from-handshake')
    assert.equal(server.frames[1].client_metadata?.['x-codex-turn-state'], 'state-from-event')
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('falls back to HTTP when the handshake is rejected and stays there for the cooldown', async () => {
  const server = await startServer(() => {}, { rejectHandshake: true })
  const pool = new CodexWebSocketPool()
  const calls: string[] = []
  const fetch = createCodexWebSocketFetch(recordingFetch(calls), {
    sessionId: 'thread-3',
    pool,
    webSocketUrl: server.url,
    fallbackCooldownMs: 60_000
  })

  try {
    const first = await fetch(HTTP_URL, post({ model: 'gpt-test' }))
    assert.equal(await first.text(), 'http-fallback')
    const second = await fetch(HTTP_URL, post({ model: 'gpt-test' }))
    assert.equal(await second.text(), 'http-fallback')

    assert.equal(server.handshakes.length, 1, 'no reconnect attempt during the cooldown')
    assert.deepEqual(calls, [`POST ${HTTP_URL}`, `POST ${HTTP_URL}`])
    assert.equal(pool.size, 0)
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('reconnects once when the pooled socket was closed between requests', async () => {
  const server = await startServer((socket) => {
    socket.send(event('response.completed', { response: {} }))
  })
  const pool = new CodexWebSocketPool()
  const fetch = createCodexWebSocketFetch(unusedFetch(), {
    sessionId: 'thread-4',
    pool,
    webSocketUrl: server.url
  })

  try {
    await (await fetch(HTTP_URL, post({ model: 'gpt-test' }))).text()
    const closed = new Promise<void>((resolve) => server.sockets[0].once('close', () => resolve()))
    server.sockets[0].close(1000)
    await closed
    // Give the client side a tick to observe the close frame.
    await new Promise((resolve) => setTimeout(resolve, 20))

    await (await fetch(HTTP_URL, post({ model: 'gpt-test' }))).text()

    assert.equal(server.handshakes.length, 2)
    assert.equal(server.frames.length, 2)
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('requests that are not Responses POSTs bypass the socket', async () => {
  const server = await startServer(() => {})
  const pool = new CodexWebSocketPool()
  const calls: string[] = []
  const fetch = createCodexWebSocketFetch(recordingFetch(calls), {
    sessionId: 'thread-5',
    pool,
    webSocketUrl: server.url
  })

  try {
    await fetch('https://chatgpt.com/backend-api/codex/models', { method: 'GET' })
    await fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3])
    })
    assert.equal(calls.length, 2)
    assert.equal(server.handshakes.length, 0)
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('aborting a streaming request drops the socket instead of leaking the stream', async () => {
  const server = await startServer((socket) => {
    socket.send(event('response.created', { response: {} }))
    // Never completes; the client must cut the connection.
  })
  const pool = new CodexWebSocketPool()
  const fetch = createCodexWebSocketFetch(unusedFetch(), {
    sessionId: 'thread-6',
    pool,
    webSocketUrl: server.url
  })
  const controller = new AbortController()

  try {
    const response = await fetch(HTTP_URL, post({ model: 'gpt-test' }, controller.signal))
    const reader = response.body!.getReader()
    const first = await reader.read()
    assert.ok(new TextDecoder().decode(first.value).includes('response.created'))

    const serverClosed = new Promise<void>((resolve) =>
      server.sockets[0].once('close', () => resolve())
    )
    controller.abort()
    await assert.rejects(reader.read(), (error: unknown) => (error as Error).name === 'AbortError')
    await serverClosed
    assert.equal(pool.size, 0)
  } finally {
    pool.closeAll()
    await server.close()
  }
})
