import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import {
  responsesEndpointKey,
  type ResponsesWebSocketSupportStore
} from './responsesWebSocketSupport.ts'

/** Shared Responses WebSocket transport, exposed as SSE for the AI SDK.
 * Codex routing metadata is enabled only by the Codex adapter.
 * Only failures before sending response.create may fall back to HTTP.
 */

const OPENAI_BETA_HEADER_VALUE = 'responses_websockets=2026-02-06'
const TURN_STATE_HEADER = 'x-codex-turn-state'
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_IDLE_CLOSE_MS = 10 * 60_000
const DEFAULT_FALLBACK_COOLDOWN_MS = 5 * 60_000
const LOG_TAG = '[yachiyo][responses-ws]'

const TERMINAL_EVENT_TYPES = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
  'error'
])

type FetchInput = Parameters<typeof globalThis.fetch>[0]

export interface ResponsesWebSocketFetchOptions {
  /** Local session scope; never sent to generic providers. */
  sessionId: string
  providerKey?: string
  supportStore?: ResponsesWebSocketSupportStore
  /** Enable Codex-specific headers and client metadata. */
  codex?: boolean
  pool?: ResponsesWebSocketPool
  connectTimeoutMs?: number
  streamIdleTimeoutMs?: number
  /** Close a socket that has served no request for this long. */
  idleCloseMs?: number
  /** After a failed handshake, use plain HTTP for this long. */
  fallbackCooldownMs?: number
  /** Override the socket endpoint (tests). Defaults to the request URL with a ws(s) scheme. */
  webSocketUrl?: string
}

class ResponsesWebSocketHandshakeError extends Error {
  readonly statusCode: number | undefined

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = 'ResponsesWebSocketHandshakeError'
    this.statusCode = statusCode
  }
}

class ResponsesWebSocketClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResponsesWebSocketClosedError'
  }
}

/** A sent generation is ambiguous on disconnect: never retry at the runtime boundary. */
class ResponsesWebSocketStreamError extends Error {
  readonly isRetryable = false
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

function toSdkEvent(event: Record<string, unknown>, original: string): string {
  if (event.type !== 'error' || !event.error || typeof event.error !== 'object') return original
  const error = event.error as Record<string, unknown>
  if (typeof error.type !== 'string' || typeof error.message !== 'string') return original
  if (typeof event.sequence_number === 'number' && typeof error.code === 'string') return original
  return JSON.stringify({
    type: 'error',
    sequence_number: typeof event.sequence_number === 'number' ? event.sequence_number : 0,
    error: {
      type: error.type,
      code:
        typeof error.code === 'string'
          ? error.code
          : typeof event.status_code === 'number' &&
              event.status_code >= 400 &&
              event.status_code <= 599
            ? String(event.status_code)
            : error.type,
      message: error.message
    }
  })
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

interface StreamRequest {
  payload: Record<string, unknown>
  codexSessionId?: string
  signal?: AbortSignal | null
  streamIdleTimeoutMs: number
  /** Turn state known before the request; the callback reports newer values. */
  turnState?: string
  onTurnState: (turnState: string) => void
}

/**
 * One socket to a Responses backend. Requests are serialized: the backend
 * streams one response per connection at a time.
 */
class ResponsesWebSocketConnection {
  readonly key: string
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly connectTimeoutMs: number
  private readonly idleCloseMs: number
  private readonly onClosed: (connection: ResponsesWebSocketConnection) => void
  private socket: WebSocket | undefined
  private chain: Promise<void> = Promise.resolve()
  private connecting: Promise<string | undefined> | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(input: {
    key: string
    url: string
    headers: Record<string, string>
    connectTimeoutMs: number
    idleCloseMs: number
    onClosed: (connection: ResponsesWebSocketConnection) => void
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
  connect(): Promise<string | undefined> {
    return (this.connecting ??= this.open())
  }

  private async open(): Promise<string | undefined> {
    const socket = new WebSocket(this.url, {
      headers: this.headers,
      perMessageDeflate: true,
      handshakeTimeout: this.connectTimeoutMs
    })
    this.socket = socket

    let handshakeTurnState: string | undefined
    socket.on('error', () => {})
    socket.on('upgrade', (response) => {
      handshakeTurnState = readHeaderTurnState(response.headers)
    })

    await new Promise<void>((resolve, reject) => {
      const onUnexpected = (_request: unknown, response: { statusCode?: number }): void => {
        cleanup()
        socket.terminate()
        reject(
          new ResponsesWebSocketHandshakeError(
            `Responses websocket handshake rejected with status ${response.statusCode ?? 'unknown'}`,
            response.statusCode
          )
        )
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(
          new ResponsesWebSocketHandshakeError(
            `Responses websocket connect failed: ${error.message}`
          )
        )
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
    this.scheduleIdleClose()
    return handshakeTurnState
  }

  /**
   * Sends one Responses request and returns its events as an SSE byte stream.
   * Rejects with `ResponsesWebSocketClosedError` when the socket dies before the
   * request is sent, so the caller can retry on a fresh connection.
   */
  request(request: StreamRequest): Promise<ReadableStream<Uint8Array>> {
    let release!: () => void
    const completed = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = this.chain.then(async () => {
      try {
        await this.connect()
        return await this.send(request, release)
      } catch (error) {
        release()
        throw error
      }
    })
    this.chain = completed
    const signal = request.signal
    if (!signal) return run
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(abortError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      void run.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  private send(request: StreamRequest, release: () => void): Promise<ReadableStream<Uint8Array>> {
    const socket = this.socket
    if (!socket || this.closed || socket.readyState !== WebSocket.OPEN) {
      this.close()
      return Promise.reject(new ResponsesWebSocketClosedError('Responses websocket is not open'))
    }
    if (request.signal?.aborted) {
      return Promise.reject(abortError(request.signal))
    }
    this.clearIdleClose()

    const encoder = new TextEncoder()
    const frame = JSON.stringify({
      ...request.payload,
      type: 'response.create',
      ...(request.codexSessionId
        ? {
            client_metadata: {
              session_id: request.codexSessionId,
              thread_id: request.codexSessionId,
              ...(request.turnState ? { [TURN_STATE_HEADER]: request.turnState } : {})
            }
          }
        : {})
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
          fail(new ResponsesWebSocketStreamError('Responses websocket stream idle timeout'))
          this.terminate()
        }, request.streamIdleTimeoutMs)
      }
      const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
        if (isBinary) {
          fail(
            new ResponsesWebSocketStreamError('Responses websocket sent an unexpected binary frame')
          )
          this.terminate()
          return
        }
        const text = data.toString()
        let event: Record<string, unknown> = {}
        try {
          event = JSON.parse(text) as Record<string, unknown>
        } catch {
          // Forward unparseable frames untouched; the SDK parser reports them.
        }
        const turnState = readEventTurnState(event)
        if (turnState) request.onTurnState(turnState)
        const sse = encoder.encode(`data: ${toSdkEvent(event, text)}\n\n`)

        if (!streamStarted) {
          streamStarted = true
          resolveStream(
            new ReadableStream<Uint8Array>({
              start(c) {
                controller = c
                controller.enqueue(sse)
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
          controller?.enqueue(sse)
        }

        if (typeof event.type === 'string' && TERMINAL_EVENT_TYPES.has(event.type)) {
          complete()
        } else {
          resetIdle()
        }
      }
      const onClose = (): void => {
        fail(
          new ResponsesWebSocketStreamError('Responses websocket closed before response.completed')
        )
      }
      const onSocketError = (error: Error): void => {
        fail(new ResponsesWebSocketStreamError(`Responses websocket error: ${error.message}`))
        this.terminate()
      }
      const onAbort = (): void => {
        fail(abortError(request.signal as AbortSignal))
        this.terminate()
      }
      const detach = (): void => {
        release()
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
          fail(
            new ResponsesWebSocketStreamError(`Responses websocket send failed: ${error.message}`)
          )
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
export class ResponsesWebSocketPool {
  private readonly connections = new Map<string, ResponsesWebSocketConnection>()
  private readonly nowImpl: () => number
  private disabledUntil = new Map<string, number>()

  constructor(nowImpl: () => number = Date.now) {
    this.nowImpl = nowImpl
  }

  get(key: string): ResponsesWebSocketConnection | undefined {
    const connection = this.connections.get(key)
    return connection && !connection.isClosed ? connection : undefined
  }

  register(connection: ResponsesWebSocketConnection): void {
    this.connections.get(connection.key)?.close()
    this.connections.set(connection.key, connection)
  }

  remove(connection: ResponsesWebSocketConnection): void {
    if (this.connections.get(connection.key) === connection) {
      this.connections.delete(connection.key)
    }
  }

  isDisabled(key: string): boolean {
    const until = this.disabledUntil.get(key) ?? 0
    if (this.nowImpl() < until) return true
    this.disabledUntil.delete(key)
    return false
  }

  disableFor(key: string, ms: number): void {
    this.disabledUntil.set(key, this.nowImpl() + ms)
  }

  get size(): number {
    return this.connections.size
  }

  closeAll(): void {
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
    this.disabledUntil.clear()
  }
}

const sharedPool = new ResponsesWebSocketPool()

export function createResponsesWebSocketFetch(
  baseFetch: typeof globalThis.fetch,
  options: ResponsesWebSocketFetchOptions
): typeof globalThis.fetch {
  const pool = options.pool ?? sharedPool
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS
  const fallbackCooldownMs = options.fallbackCooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS
  // Turn state is scoped to one model run (this fetch instance), like Codex's
  // per-turn session; it is replayed on every request and reconnect of the run.
  let turnState: string | undefined
  const rememberTurnState = (value: string): void => {
    turnState = value
  }

  const openConnection = async (
    key: string,
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal | null
  ): Promise<ResponsesWebSocketConnection> => {
    const connection = new ResponsesWebSocketConnection({
      key,
      url,
      headers: {
        ...headers,
        ...(options.codex
          ? {
              'openai-beta': OPENAI_BETA_HEADER_VALUE,
              'session-id': options.sessionId,
              'thread-id': options.sessionId,
              ...(turnState ? { [TURN_STATE_HEADER]: turnState } : {})
            }
          : {})
      },
      connectTimeoutMs,
      idleCloseMs,
      onClosed: (closed) => pool.remove(closed)
    })
    pool.register(connection)
    const onAbort = (): void => connection.close()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const handshakeTurnState = await connection.connect()
      if (options.codex && handshakeTurnState) rememberTurnState(handshakeTurnState)
    } catch (error) {
      connection.close()
      throw signal?.aborted ? abortError(signal) : error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    console.info(`${LOG_TAG} connected key=${key}`)
    return connection
  }

  return async (input, init) => {
    if (!isResponsesPost(input, init) || typeof init?.body !== 'string') {
      return baseFetch(input, init)
    }

    if (init.signal?.aborted) throw abortError(init.signal)

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

    // Non-streaming SDK calls expect JSON, not the SSE interface exposed below.
    if (!options.codex && payload['stream'] !== true) return baseFetch(input, init)

    const url = options.webSocketUrl ?? toWebSocketUrl(requestUrl(input))
    const endpoint = responsesEndpointKey(url)
    const supportStore = options.codex ? undefined : options.supportStore
    if (options.providerKey && supportStore?.isUnsupported(options.providerKey, endpoint)) {
      return baseFetch(input, init)
    }
    const headers = toRecordHeaders(
      init.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    delete headers['content-type']
    delete headers['content-length']
    // Hash all handshake headers so credentials never appear in keys/logs.
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          options.sessionId,
          options.providerKey,
          options.codex === true,
          url,
          Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))
        ])
      )
      .digest('hex')
    if (pool.isDisabled(key)) return baseFetch(input, init)
    // stream is an HTTP/SSE option, not part of generic response.create.
    if (!options.codex) {
      payload = { ...payload }
      delete payload['stream']
    }

    const streamOnce = async (): Promise<ReadableStream<Uint8Array>> => {
      const connection = pool.get(key) ?? (await openConnection(key, url, headers, init.signal))
      return connection.request({
        payload,
        codexSessionId: options.codex ? options.sessionId : undefined,
        signal: init.signal,
        streamIdleTimeoutMs,
        turnState,
        onTurnState: (value) => {
          if (options.codex) rememberTurnState(value)
        }
      })
    }

    let stream: ReadableStream<Uint8Array>
    try {
      try {
        stream = await streamOnce()
      } catch (error) {
        if (!(error instanceof ResponsesWebSocketClosedError)) throw error
        // The pooled socket died between requests (e.g. the backend's 60 minute
        // connection limit): reconnect once before giving up on the transport.
        console.info(`${LOG_TAG} reconnecting key=${key}: ${error.message}`)
        stream = await streamOnce()
      }
    } catch (error) {
      if (init.signal?.aborted) throw error
      if (
        error instanceof ResponsesWebSocketHandshakeError ||
        error instanceof ResponsesWebSocketClosedError
      ) {
        console.warn(`${LOG_TAG} falling back to HTTP after a pre-send failure: ${error.message}`)
        const unsupported =
          error instanceof ResponsesWebSocketHandshakeError &&
          [404, 405, 501].includes(error.statusCode ?? 0)
        if (unsupported && supportStore && options.providerKey) {
          try {
            supportStore.markUnsupported(options.providerKey, endpoint)
          } catch {
            // A persistence failure must not prevent safe HTTP fallback.
            console.warn(`${LOG_TAG} could not persist unsupported endpoint`)
          }
        } else {
          pool.disableFor(key, fallbackCooldownMs)
        }
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
