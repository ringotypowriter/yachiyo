import WebSocket from 'ws'

/**
 * WebSocket transport for the Codex OAuth backend.
 *
 * The Codex backend routes each HTTP `/responses` POST independently, so a
 * multi-step run rarely lands on the machine that holds its prompt cache.
 * Codex CLI keeps one WebSocket per thread instead and replays the
 * `x-codex-turn-state` token, which is what makes its cache hits stick.
 *
 * This module mirrors that: the returned `fetch` tunnels `/responses` POSTs
 * over a pooled per-thread socket and converts the event frames back into an
 * SSE body, so the AI SDK provider keeps working unchanged. Anything that is
 * not a Responses POST, and any handshake failure, falls through to the plain
 * HTTP fetch.
 */

const OPENAI_BETA_HEADER_VALUE = 'responses_websockets=2026-02-06'
const TURN_STATE_HEADER = 'x-codex-turn-state'
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_IDLE_CLOSE_MS = 10 * 60_000
const DEFAULT_FALLBACK_COOLDOWN_MS = 5 * 60_000
const LOG_TAG = '[yachiyo][codex-ws]'

const TERMINAL_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'error'
])

type FetchInput = Parameters<typeof globalThis.fetch>[0]

export interface CodexWebSocketFetchOptions {
  /** Thread-scoped key: one socket per value, also sent as `session-id` / `thread-id`. */
  sessionId: string
  pool?: CodexWebSocketPool
  connectTimeoutMs?: number
  streamIdleTimeoutMs?: number
  /** Close a socket that has served no request for this long. */
  idleCloseMs?: number
  /** After a failed handshake, use plain HTTP for this long. */
  fallbackCooldownMs?: number
  nowImpl?: () => number
  /** Override the socket endpoint (tests). Defaults to the request URL with a ws(s) scheme. */
  webSocketUrl?: string
}

class CodexWebSocketHandshakeError extends Error {
  readonly statusCode: number | undefined

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = 'CodexWebSocketHandshakeError'
    this.statusCode = statusCode
  }
}

class CodexWebSocketClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexWebSocketClosedError'
  }
}

function toRecordHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => {
    result[key] = value
  })
  return result
}

function requestUrl(input: FetchInput): string {
  return typeof input === 'string' || input instanceof URL ? String(input) : input.url
}

function isResponsesPost(input: FetchInput, init: RequestInit | undefined): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'POST') return false
  try {
    return new URL(requestUrl(input)).pathname.endsWith('/responses')
  } catch {
    return false
  }
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'http:' ? 'ws:' : 'wss:'
  return parsed.toString()
}

function readHeaderTurnState(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === TURN_STATE_HEADER && typeof value === 'string' && value) {
      return value
    }
  }
  return undefined
}

function readEventTurnState(event: { type?: unknown; headers?: unknown }): string | undefined {
  return event.type === 'response.metadata' ? readHeaderTurnState(event.headers) : undefined
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

interface StreamRequest {
  payload: Record<string, unknown>
  signal?: AbortSignal | null
  streamIdleTimeoutMs: number
  /** Turn state known before the request; the callback reports newer values. */
  turnState?: string
  onTurnState: (turnState: string) => void
}

/**
 * One socket to the Codex backend. Requests are serialized: the backend
 * streams one response per connection at a time.
 */
class CodexWebSocketConnection {
  readonly key: string
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly connectTimeoutMs: number
  private readonly idleCloseMs: number
  private readonly onClosed: (connection: CodexWebSocketConnection) => void
  private socket: WebSocket | undefined
  private chain: Promise<void> = Promise.resolve()
  private idleTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(input: {
    key: string
    url: string
    headers: Record<string, string>
    connectTimeoutMs: number
    idleCloseMs: number
    onClosed: (connection: CodexWebSocketConnection) => void
  }) {
    this.key = input.key
    this.url = input.url
    this.headers = input.headers
    this.connectTimeoutMs = input.connectTimeoutMs
    this.idleCloseMs = input.idleCloseMs
    this.onClosed = input.onClosed
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Opens the socket and resolves the turn state from the handshake response, if any. */
  async connect(): Promise<string | undefined> {
    const socket = new WebSocket(this.url, {
      headers: this.headers,
      perMessageDeflate: true,
      handshakeTimeout: this.connectTimeoutMs
    })
    this.socket = socket

    let handshakeTurnState: string | undefined
    socket.on('upgrade', (response) => {
      handshakeTurnState = readHeaderTurnState(response.headers)
    })

    await new Promise<void>((resolve, reject) => {
      const onUnexpected = (_request: unknown, response: { statusCode?: number }): void => {
        cleanup()
        reject(
          new CodexWebSocketHandshakeError(
            `Codex websocket handshake rejected with status ${response.statusCode ?? 'unknown'}`,
            response.statusCode
          )
        )
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(new CodexWebSocketHandshakeError(`Codex websocket connect failed: ${error.message}`))
      }
      const onOpen = (): void => {
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        socket.off('unexpected-response', onUnexpected)
        socket.off('error', onError)
        socket.off('open', onOpen)
      }
      socket.once('unexpected-response', onUnexpected)
      socket.once('error', onError)
      socket.once('open', onOpen)
    })

    socket.on('close', () => this.markClosed())
    // Errors after the handshake are surfaced through the active stream; an
    // idle socket that errors simply drops out of the pool via `close`.
    socket.on('error', () => {})
    this.scheduleIdleClose()
    return handshakeTurnState
  }

  /**
   * Sends one Responses request and returns its events as an SSE byte stream.
   * Rejects with `CodexWebSocketClosedError` when the socket dies before the
   * first frame, so the caller can retry on a fresh connection.
   */
  request(request: StreamRequest): Promise<ReadableStream<Uint8Array>> {
    const run = this.chain.then(() => this.send(request))
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private send(request: StreamRequest): Promise<ReadableStream<Uint8Array>> {
    const socket = this.socket
    if (!socket || this.closed || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CodexWebSocketClosedError('Codex websocket is not open'))
    }
    if (request.signal?.aborted) {
      return Promise.reject(abortError(request.signal))
    }
    this.clearIdleClose()

    const encoder = new TextEncoder()
    const frame = JSON.stringify({
      ...request.payload,
      type: 'response.create',
      client_metadata: {
        session_id: this.key,
        thread_id: this.key,
        ...(request.turnState ? { [TURN_STATE_HEADER]: request.turnState } : {})
      }
    })

    return new Promise<ReadableStream<Uint8Array>>((resolveStream, rejectStream) => {
      let streamStarted = false
      let finished = false
      let idleTimer: NodeJS.Timeout | undefined
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined

      const fail = (error: unknown): void => {
        if (finished) return
        finished = true
        detach()
        if (streamStarted) {
          controller?.error(error)
        } else {
          rejectStream(error)
        }
      }
      const complete = (): void => {
        if (finished) return
        finished = true
        detach()
        controller?.close()
        this.scheduleIdleClose()
      }
      const resetIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          fail(new Error('Codex websocket stream idle timeout'))
          this.terminate()
        }, request.streamIdleTimeoutMs)
      }
      const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
        if (isBinary) {
          fail(new Error('Codex websocket sent an unexpected binary frame'))
          this.terminate()
          return
        }
        const text = data.toString()
        let event: { type?: unknown; headers?: unknown } = {}
        try {
          event = JSON.parse(text) as { type?: unknown; headers?: unknown }
        } catch {
          // Forward unparseable frames untouched; the SDK parser reports them.
        }
        const turnState = readEventTurnState(event)
        if (turnState) request.onTurnState(turnState)

        if (!streamStarted) {
          streamStarted = true
          resolveStream(
            new ReadableStream<Uint8Array>({
              start(c) {
                controller = c
                controller.enqueue(encoder.encode(`data: ${text}\n\n`))
              },
              cancel: () => {
                // Consumer went away (abort): the backend keeps streaming on
                // this socket, so drop the connection instead of the frames.
                if (!finished) {
                  finished = true
                  detach()
                  this.terminate()
                }
              }
            })
          )
        } else {
          controller?.enqueue(encoder.encode(`data: ${text}\n\n`))
        }

        if (typeof event.type === 'string' && TERMINAL_EVENT_TYPES.has(event.type)) {
          complete()
        } else {
          resetIdle()
        }
      }
      const onClose = (): void => {
        fail(
          streamStarted
            ? new Error('Codex websocket closed before response.completed')
            : new CodexWebSocketClosedError('Codex websocket closed before the first event')
        )
      }
      const onSocketError = (error: Error): void => {
        fail(
          streamStarted
            ? new Error(`Codex websocket error: ${error.message}`)
            : new CodexWebSocketClosedError(`Codex websocket error: ${error.message}`)
        )
      }
      const onAbort = (): void => {
        fail(abortError(request.signal as AbortSignal))
        this.terminate()
      }
      const detach = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        socket.off('message', onMessage)
        socket.off('close', onClose)
        socket.off('error', onSocketError)
        request.signal?.removeEventListener('abort', onAbort)
      }

      socket.on('message', onMessage)
      socket.on('close', onClose)
      socket.on('error', onSocketError)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      resetIdle()

      socket.send(frame, (error) => {
        if (error) {
          fail(new CodexWebSocketClosedError(`Codex websocket send failed: ${error.message}`))
          this.terminate()
        }
      })
    })
  }

  close(): void {
    this.clearIdleClose()
    const socket = this.socket
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1000)
    } else {
      this.terminate()
    }
    this.markClosed()
  }

  private terminate(): void {
    this.socket?.terminate()
    this.markClosed()
  }

  private markClosed(): void {
    if (this.closed) return
    this.closed = true
    this.clearIdleClose()
    this.onClosed(this)
  }

  private scheduleIdleClose(): void {
    this.clearIdleClose()
    this.idleTimer = setTimeout(() => {
      console.info(`${LOG_TAG} closing idle connection key=${this.key}`)
      this.close()
    }, this.idleCloseMs)
    this.idleTimer.unref?.()
  }

  private clearIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

/** Process-wide connection registry keyed by thread; shared by every model instance. */
export class CodexWebSocketPool {
  private readonly connections = new Map<string, CodexWebSocketConnection>()
  private readonly nowImpl: () => number
  private disabledUntil = 0

  constructor(nowImpl: () => number = Date.now) {
    this.nowImpl = nowImpl
  }

  get(key: string): CodexWebSocketConnection | undefined {
    const connection = this.connections.get(key)
    return connection && !connection.isClosed ? connection : undefined
  }

  register(connection: CodexWebSocketConnection): void {
    this.connections.get(connection.key)?.close()
    this.connections.set(connection.key, connection)
  }

  remove(connection: CodexWebSocketConnection): void {
    if (this.connections.get(connection.key) === connection) {
      this.connections.delete(connection.key)
    }
  }

  isDisabled(): boolean {
    return this.nowImpl() < this.disabledUntil
  }

  disableFor(ms: number): void {
    this.disabledUntil = this.nowImpl() + ms
  }

  get size(): number {
    return this.connections.size
  }

  closeAll(): void {
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
  }
}

const sharedPool = new CodexWebSocketPool()

export function createCodexWebSocketFetch(
  baseFetch: typeof globalThis.fetch,
  options: CodexWebSocketFetchOptions
): typeof globalThis.fetch {
  const pool = options.pool ?? sharedPool
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS
  const fallbackCooldownMs = options.fallbackCooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS
  const key = options.sessionId
  // Turn state is scoped to one model run (this fetch instance), like Codex's
  // per-turn session; it is replayed on every request and reconnect of the run.
  let turnState: string | undefined
  const rememberTurnState = (value: string): void => {
    turnState = value
  }

  const openConnection = async (
    url: string,
    headers: Record<string, string>
  ): Promise<CodexWebSocketConnection> => {
    const connection = new CodexWebSocketConnection({
      key,
      url,
      headers: {
        ...headers,
        'OpenAI-Beta': OPENAI_BETA_HEADER_VALUE,
        'session-id': key,
        'thread-id': key,
        ...(turnState ? { [TURN_STATE_HEADER]: turnState } : {})
      },
      connectTimeoutMs,
      idleCloseMs,
      onClosed: (closed) => pool.remove(closed)
    })
    pool.register(connection)
    try {
      const handshakeTurnState = await connection.connect()
      if (handshakeTurnState) rememberTurnState(handshakeTurnState)
    } catch (error) {
      pool.remove(connection)
      throw error
    }
    console.info(`${LOG_TAG} connected key=${key}`)
    return connection
  }

  return async (input, init) => {
    if (!isResponsesPost(input, init) || typeof init?.body !== 'string' || pool.isDisabled()) {
      return baseFetch(input, init)
    }

    let payload: Record<string, unknown>
    try {
      const parsed = JSON.parse(init.body) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return baseFetch(input, init)
      }
      payload = parsed as Record<string, unknown>
    } catch {
      return baseFetch(input, init)
    }

    const url = options.webSocketUrl ?? toWebSocketUrl(requestUrl(input))
    const headers = toRecordHeaders(init.headers)
    delete headers['content-type']
    delete headers['content-length']

    const streamOnce = async (): Promise<ReadableStream<Uint8Array>> => {
      const connection = pool.get(key) ?? (await openConnection(url, headers))
      return connection.request({
        payload,
        signal: init.signal,
        streamIdleTimeoutMs,
        turnState,
        onTurnState: rememberTurnState
      })
    }

    let stream: ReadableStream<Uint8Array>
    try {
      try {
        stream = await streamOnce()
      } catch (error) {
        if (!(error instanceof CodexWebSocketClosedError)) throw error
        // The pooled socket died between requests (e.g. the backend's 60 minute
        // connection limit): reconnect once before giving up on the transport.
        console.info(`${LOG_TAG} reconnecting key=${key}: ${error.message}`)
        stream = await streamOnce()
      }
    } catch (error) {
      if (init.signal?.aborted) throw error
      if (
        error instanceof CodexWebSocketHandshakeError ||
        error instanceof CodexWebSocketClosedError
      ) {
        console.warn(
          `${LOG_TAG} falling back to HTTP for ${Math.round(fallbackCooldownMs / 1000)}s: ${error.message}`
        )
        pool.disableFor(fallbackCooldownMs)
        return baseFetch(input, init)
      }
      throw error
    }

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
    })
  }
}
