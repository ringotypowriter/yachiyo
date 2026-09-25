import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import test from 'node:test'

import { WebSocketServer, type WebSocket } from 'ws'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'

import { CodexWebSocketPool, createCodexWebSocketFetch } from './codexResponsesWebSocket.ts'
import { createResponsesWebSocketFetch } from './responsesWebSocket.ts'
import { isTransientTransportError } from '../models/runtimeErrors.ts'

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
    body: JSON.stringify({ stream: true, ...body }),
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

test('Codex websocket usage limits surface the provider message instead of schema errors', async () => {
  const server = await startServer((socket) => {
    socket.send(
      event('error', {
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
          resets_in_seconds: 430690
        },
        status_code: 429,
        headers: { 'X-Codex-Primary-Used-Percent': '100' }
      })
    )
  })
  const pool = new CodexWebSocketPool()
  const fetch = createCodexWebSocketFetch(unusedFetch(), {
    sessionId: 'usage-limit',
    pool,
    webSocketUrl: server.url
  })

  try {
    const provider = createOpenAI({
      apiKey: 'fixture',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      fetch
    })
    const result = streamText({
      model: provider.responses('model'),
      prompt: 'local fixture',
      maxRetries: 0
    })
    let streamError: unknown
    for await (const part of result.fullStream) {
      if (part.type === 'error') streamError = part.error
    }
    assert.ok(streamError instanceof Error)
    assert.equal(streamError.message, 'The usage limit has been reached')
    assert.equal((streamError as Error & { statusCode?: number }).statusCode, 429)
    assert.equal(server.frames.length, 1)
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

test('generic Responses preserves endpoint, auth and body without Codex metadata', async () => {
  const server = await startServer((socket) => socket.send(event('response.completed')))
  const pool = new CodexWebSocketPool()
  const fetch = createResponsesWebSocketFetch(unusedFetch(), { sessionId: 'generic', pool })
  try {
    const url = server.url.replace('ws:', 'http:').replace('/responses', '/v1/responses?route=test')
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer generic-key',
        'x-custom': 'custom',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'model',
        stream: true,
        max_output_tokens: 42,
        client_metadata: { custom: 'value' }
      })
    })
    assert.match(await response.text(), /data:.*response.completed/)
    assert.equal(server.handshakes[0].url, '/v1/responses?route=test')
    const headers = server.handshakes[0].headers
    assert.equal(headers.authorization, 'Bearer generic-key')
    assert.equal(headers['x-custom'], 'custom')
    assert.equal(headers['session-id'], undefined)
    assert.equal(headers['thread-id'], undefined)
    assert.equal(headers['openai-beta'], undefined)
    assert.equal(headers['chatgpt-account-id'], undefined)
    assert.equal(headers['content-type'], undefined)
    assert.deepEqual(server.frames[0], {
      type: 'response.create',
      model: 'model',
      max_output_tokens: 42,
      client_metadata: { custom: 'value' }
    })
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('generic pool reuses across fetch instances but isolates session, provider, endpoint and auth', async () => {
  const server = await startServer((socket) => socket.send(event('response.completed')))
  const pool = new CodexWebSocketPool()
  const url = server.url.replace('ws:', 'http:')
  const send = async (
    sessionId: string,
    providerKey: string,
    endpoint = url,
    token = 'one'
  ): Promise<void> => {
    const fetch = createResponsesWebSocketFetch(unusedFetch(), { sessionId, providerKey, pool })
    await (
      await fetch(endpoint, {
        ...post({ model: 'model' }),
        headers: { authorization: `Bearer ${token}` }
      })
    ).text()
  }
  try {
    await send('session', 'provider')
    await send('session', 'provider')
    assert.equal(server.handshakes.length, 1)
    await send('other-session', 'provider')
    await send('session', 'other-provider')
    await send('session', 'provider', `${url}?route=other`)
    await send('session', 'provider', url, 'rotated')
    assert.equal(server.handshakes.length, 5)
  } finally {
    pool.closeAll()
    await server.close()
  }
})

for (const firstEvent of [false, true]) {
  test(`disconnect after send never replays or falls back (first event: ${firstEvent})`, async () => {
    const server = await startServer((socket) => {
      if (firstEvent) socket.send(event('response.created'))
      socket.close()
    })
    const pool = new CodexWebSocketPool()
    const calls: string[] = []
    const fetch = createResponsesWebSocketFetch(recordingFetch(calls), {
      sessionId: 'no-replay',
      pool
    })
    try {
      await assert.rejects(
        async () => {
          const response = await fetch(server.url.replace('ws:', 'http:'), post({ model: 'model' }))
          await response.text()
        },
        (error: Error & { isRetryable?: boolean }) => {
          assert.match(error.message, /closed before response.completed/)
          assert.equal(error.isRetryable, false)
          assert.equal(isTransientTransportError(error), false)
          return true
        }
      )
      assert.equal(server.frames.length, 1)
      assert.equal(server.handshakes.length, 1)
      assert.equal(calls.length, 0)
    } finally {
      pool.closeAll()
      await server.close()
    }
  })
}

test('generic handshake fallback cooldown is isolated by endpoint', async () => {
  const rejected = await startServer(() => {}, { rejectHandshake: true })
  const accepted = await startServer((socket) => socket.send(event('response.completed')))
  const pool = new CodexWebSocketPool()
  const calls: string[] = []
  const fetch = createResponsesWebSocketFetch(recordingFetch(calls), {
    sessionId: 'fallback',
    pool
  })
  try {
    const url = rejected.url.replace('ws:', 'http:')
    assert.equal(await (await fetch(url, post({}))).text(), 'http-fallback')
    assert.equal(await (await fetch(url, post({}))).text(), 'http-fallback')
    assert.match(
      await (await fetch(accepted.url.replace('ws:', 'http:'), post({}))).text(),
      /response.completed/
    )
    assert.equal(rejected.handshakes.length, 1)
    assert.equal(calls.length, 2)
  } finally {
    pool.closeAll()
    await rejected.close()
    await accepted.close()
  }
})

test('generic consumer cancellation closes the active socket', async () => {
  const server = await startServer((socket) => socket.send(event('response.created')))
  const pool = new CodexWebSocketPool()
  const fetch = createResponsesWebSocketFetch(unusedFetch(), { sessionId: 'cancel', pool })
  try {
    const response = await fetch(server.url.replace('ws:', 'http:'), post({}))
    const closed = new Promise<void>((resolve) => server.sockets[0].once('close', () => resolve()))
    await response.body!.cancel()
    await closed
    assert.equal(pool.size, 0)
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('concurrent requests wait for the terminal event, not just the first frame', async () => {
  const server = await startServer((socket, _frame, index) => {
    socket.send(event('response.created'))
    if (index > 0) socket.send(event('response.completed'))
  })
  const pool = new CodexWebSocketPool()
  const fetch = createResponsesWebSocketFetch(unusedFetch(), { sessionId: 'serial', pool })
  try {
    const url = server.url.replace('ws:', 'http:')
    const first = await fetch(url, post({}))
    const second = fetch(url, post({}))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(server.frames.length, 1)
    server.sockets[0].send(event('response.completed'))
    await first.text()
    await (await second).text()
    assert.equal(server.frames.length, 2)
    assert.equal(server.handshakes.length, 1)
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('abort during handshake rejects without HTTP fallback or a leaked connection', async () => {
  const server = createServer()
  let disconnect: (() => void) | undefined
  const handshake = new Promise<void>((resolve) => {
    server.on('upgrade', (_request, socket) => {
      disconnect = () => socket.destroy()
      resolve()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const pool = new CodexWebSocketPool()
  const controller = new AbortController()
  const calls: string[] = []
  const fetch = createResponsesWebSocketFetch(recordingFetch(calls), {
    sessionId: 'handshake-abort',
    pool
  })
  try {
    const result = fetch(`http://127.0.0.1:${address.port}/responses`, post({}, controller.signal))
    const rejected = assert.rejects(result, (error: Error) => error.name === 'AbortError')
    await handshake
    controller.abort()
    await rejected
    assert.equal(pool.size, 0)
    assert.equal(calls.length, 0)
  } finally {
    pool.closeAll()
    disconnect?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('aborting a queued request is immediate and does not cancel or replay the active request', async () => {
  const server = await startServer((socket) => socket.send(event('response.created')))
  const pool = new CodexWebSocketPool()
  const fetch = createResponsesWebSocketFetch(unusedFetch(), { sessionId: 'queued-abort', pool })
  try {
    const url = server.url.replace('ws:', 'http:')
    const first = await fetch(url, post({}))
    const controller = new AbortController()
    const second = fetch(url, post({}, controller.signal))
    controller.abort()
    await assert.rejects(second, (error: Error) => error.name === 'AbortError')
    assert.equal(server.frames.length, 1)
    server.sockets[0].send(event('response.completed'))
    await first.text()
    assert.equal(pool.size, 1)
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('aborting after send but before the first event never replays', async () => {
  let received!: () => void
  const frameReceived = new Promise<void>((resolve) => {
    received = resolve
  })
  const server = await startServer(() => received())
  const pool = new CodexWebSocketPool()
  const calls: string[] = []
  const fetch = createResponsesWebSocketFetch(recordingFetch(calls), {
    sessionId: 'early-abort',
    pool
  })
  const controller = new AbortController()
  try {
    const response = fetch(server.url.replace('ws:', 'http:'), post({}, controller.signal))
    const rejected = assert.rejects(response, (error: Error) => error.name === 'AbortError')
    await frameReceived
    controller.abort()
    await rejected
    assert.equal(server.frames.length, 1)
    assert.equal(calls.length, 0)
    assert.equal(pool.size, 0)
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('generic nonstream Responses requests preserve HTTP JSON semantics', async () => {
  const server = await startServer(() => {
    throw new Error('Nonstream call must not open WebSocket')
  })
  const pool = new CodexWebSocketPool()
  const requests: RequestInit[] = []
  const fetch = createResponsesWebSocketFetch(
    async (_input, init) => {
      requests.push(init!)
      return Response.json({ id: 'response', output: [] })
    },
    { sessionId: 'nonstream', pool }
  )
  try {
    for (const body of [{ model: 'model' }, { model: 'model', stream: false }]) {
      const init = { method: 'POST', body: JSON.stringify(body) }
      const response = await fetch(server.url.replace('ws:', 'http:'), init)
      assert.deepEqual(await response.json(), { id: 'response', output: [] })
      assert.equal(requests.at(-1), init)
    }
    assert.equal(server.handshakes.length, 0)
    assert.equal(requests.length, 2)
  } finally {
    pool.closeAll()
    await server.close()
  }
})

test('AI SDK streaming preserves nonretryable disconnect errors for the runtime boundary', async () => {
  const server = await startServer((socket) => socket.close())
  const pool = new CodexWebSocketPool()
  const calls: string[] = []
  const fetch = createResponsesWebSocketFetch(recordingFetch(calls), {
    sessionId: 'sdk-no-replay',
    pool
  })
  try {
    const provider = createOpenAI({
      apiKey: 'fixture',
      baseURL: server.url.replace('ws:', 'http:').replace('/responses', ''),
      fetch
    })
    const result = streamText({
      model: provider.responses('model'),
      prompt: 'local fixture',
      maxRetries: 2
    })
    let streamError: unknown
    for await (const part of result.fullStream) {
      if (part.type === 'error') streamError = part.error
    }
    assert.ok(streamError instanceof Error)
    assert.equal((streamError as Error & { isRetryable: boolean }).isRetryable, false)
    assert.equal(isTransientTransportError(streamError), false)
    assert.equal(server.frames.length, 1)
    assert.equal(calls.length, 0)
  } finally {
    pool.closeAll()
    await server.close()
  }
})
