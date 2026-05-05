/**
 * QQ Official Bot API client (appId + clientSecret OAuth2).
 *
 * Connects via WebSocket gateway for receiving events, sends messages
 * via REST API. Handles token refresh, heartbeat, session resume, and
 * auto-reconnect with exponential backoff. No external dependencies
 * beyond Node 22 built-in WebSocket and fetch.
 *
 * Reference: https://bot.q.qq.com/wiki/develop/api-v2/
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QQBotC2CMessage {
  /** Opaque user identifier (not raw QQ number). */
  openId: string
  /** Message content (plain text). */
  content: string
  /** Platform-assigned message ID. */
  messageId: string
  /** ISO 8601 timestamp string. */
  timestamp: string
}

export interface QQBotClientOptions {
  appId: string
  clientSecret: string
}

export interface QQBotClient {
  connect(): void
  close(): Promise<void>
  onC2CMessage(handler: (msg: QQBotC2CMessage) => void): void
  /** Send a text message to a C2C user. replyMsgId is required (passive reply). */
  sendC2CMessage(openId: string, text: string, replyMsgId: string): Promise<void>
  /**
   * Show "typing…" indicator to a C2C user.
   * Uses `msg_type: 6` with `input_notify`. The indicator stays visible
   * for `durationSec` (default 60). Call repeatedly to keep it alive.
   */
  sendTypingIndicator(openId: string, replyMsgId: string, durationSec?: number): Promise<void>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = 'https://api.sgroup.qq.com'
/** C2C + interaction intents. */
const INTENTS = (1 << 25) | (1 << 26)

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
const MAX_RECONNECT_ATTEMPTS = 100

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createQQBotClient(options: QQBotClientOptions): QQBotClient {
  const { appId, clientSecret } = options

  // Per-send sequence counter (must be unique per reply chain).
  let msgSeqCounter = 1

  // Token state
  let accessToken = ''
  let tokenExpiresAt = 0
  let tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null
  let tokenFetchInFlight: Promise<string> | null = null

  // WebSocket state
  let ws: WebSocket | null = null
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  let lastSeq: number | null = null
  let sessionId: string | null = null
  let reconnectAttempt = 0
  let intentionallyClosed = false

  const c2cMessageHandlers: Array<(msg: QQBotC2CMessage) => void> = []

  // ------------------------------------------------------------------
  // Token management
  // ------------------------------------------------------------------

  async function fetchAccessToken(): Promise<string> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret })
    })

    if (!res.ok) {
      throw new Error(`[qqbot] token fetch failed: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as { access_token: string; expires_in: number }
    accessToken = data.access_token
    const expiresInMs = data.expires_in * 1_000
    tokenExpiresAt = Date.now() + expiresInMs

    // Proactive refresh: min(5 minutes, remaining / 3) before expiry.
    const refreshIn = expiresInMs - Math.min(5 * 60_000, expiresInMs / 3)
    scheduleTokenRefresh(refreshIn)

    console.log(
      `[qqbot] token acquired (expires in ${Math.round(data.expires_in / 60)}m, refresh in ${Math.round(refreshIn / 60_000)}m)`
    )
    return accessToken
  }

  function scheduleTokenRefresh(delayMs: number): void {
    if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer)
    tokenRefreshTimer = setTimeout(() => {
      void getToken().catch((err) => console.error('[qqbot] background token refresh failed:', err))
    }, delayMs)
  }

  /** Get a valid token, fetching/refreshing if needed. Deduplicates concurrent calls. */
  async function getToken(): Promise<string> {
    if (accessToken && Date.now() < tokenExpiresAt - 30_000) {
      return accessToken
    }
    if (tokenFetchInFlight) return tokenFetchInFlight
    tokenFetchInFlight = fetchAccessToken().finally(() => {
      tokenFetchInFlight = null
    })
    return tokenFetchInFlight
  }

  // ------------------------------------------------------------------
  // REST API helpers
  // ------------------------------------------------------------------

  async function apiRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const token = await getToken()
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json'
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`[qqbot] API ${method} ${path} failed: ${res.status} ${text}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      return res.json()
    }
    return undefined
  }

  // ------------------------------------------------------------------
  // WebSocket gateway
  // ------------------------------------------------------------------

  async function connectGateway(): Promise<void> {
    const token = await getToken()
    const gatewayRes = (await apiRequest('GET', '/gateway')) as { url: string }
    const gatewayUrl = gatewayRes.url

    console.log(`[qqbot] connecting to gateway: ${gatewayUrl}`)

    ws = new WebSocket(gatewayUrl)

    ws.addEventListener('open', () => {
      console.log('[qqbot] gateway connected')
      reconnectAttempt = 0
    })

    ws.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as GatewayPayload
        handleGatewayPayload(payload, token)
      } catch {
        // Ignore malformed messages.
      }
    })

    ws.addEventListener('close', (event) => {
      ws = null
      stopHeartbeat()
      if (!intentionallyClosed) {
        console.log(
          `[qqbot] gateway closed (code=${event.code}), scheduling reconnect #${reconnectAttempt + 1}`
        )
        scheduleReconnect()
      }
    })

    ws.addEventListener('error', (event) => {
      const detail = 'message' in event ? (event as { message: string }).message : 'unknown'
      console.error(`[qqbot] gateway error: ${detail}`)
    })
  }

  interface GatewayPayload {
    op: number
    d?: unknown
    s?: number
    t?: string
  }

  function handleGatewayPayload(payload: GatewayPayload, token: string): void {
    if (payload.s != null) {
      lastSeq = payload.s
    }

    switch (payload.op) {
      // Hello — start heartbeat and identify/resume.
      case 10: {
        const hello = payload.d as { heartbeat_interval: number }
        startHeartbeat(hello.heartbeat_interval)

        if (sessionId && lastSeq != null) {
          // Resume existing session.
          sendGateway(6, { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq })
          console.log(`[qqbot] resuming session ${sessionId} at seq ${lastSeq}`)
        } else {
          // Fresh identify.
          sendGateway(2, {
            token: `QQBot ${token}`,
            intents: INTENTS,
            shard: [0, 1]
          })
        }
        break
      }

      // Dispatch event.
      case 0:
        handleDispatch(payload.t!, payload.d)
        break

      // Heartbeat ACK — nothing to do.
      case 11:
        break

      // Reconnect requested by server.
      case 7:
        console.log('[qqbot] server requested reconnect')
        ws?.close()
        break

      // Invalid session — clear session and re-identify.
      case 9:
        console.log('[qqbot] invalid session, clearing and reconnecting')
        sessionId = null
        lastSeq = null
        ws?.close()
        break
    }
  }

  function handleDispatch(eventType: string, data: unknown): void {
    if (eventType === 'READY') {
      const ready = data as { session_id: string }
      sessionId = ready.session_id
      console.log(`[qqbot] session ready: ${sessionId}`)
      return
    }

    if (eventType === 'RESUMED') {
      console.log('[qqbot] session resumed')
      return
    }

    if (eventType === 'C2C_MESSAGE_CREATE') {
      const d = data as {
        id: string
        author: { user_openid: string }
        content: string
        timestamp: string
      }

      const msg: QQBotC2CMessage = {
        openId: d.author.user_openid,
        content: (d.content ?? '').trim(),
        messageId: d.id,
        timestamp: d.timestamp
      }

      for (const handler of c2cMessageHandlers) {
        handler(msg)
      }
    }
  }

  function sendGateway(op: number, d?: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ op, d }))
  }

  function startHeartbeat(intervalMs: number): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      sendGateway(1, lastSeq)
    }, intervalMs)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function scheduleReconnect(): void {
    if (intentionallyClosed || reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    reconnectAttempt++
    setTimeout(() => {
      if (!intentionallyClosed) {
        void connectGateway().catch((err) => {
          console.error('[qqbot] reconnect failed:', err)
          scheduleReconnect()
        })
      }
    }, delay)
  }

  // ------------------------------------------------------------------
  // Public interface
  // ------------------------------------------------------------------

  return {
    connect(): void {
      intentionallyClosed = false
      void connectGateway().catch((err) => {
        console.error('[qqbot] initial connection failed:', err)
        scheduleReconnect()
      })
    },

    async close(): Promise<void> {
      intentionallyClosed = true
      stopHeartbeat()
      if (tokenRefreshTimer) {
        clearTimeout(tokenRefreshTimer)
        tokenRefreshTimer = null
      }
      if (ws) {
        ws.close()
        ws = null
      }
    },

    onC2CMessage(handler: (msg: QQBotC2CMessage) => void): void {
      c2cMessageHandlers.push(handler)
    },

    async sendC2CMessage(openId: string, text: string, replyMsgId: string): Promise<void> {
      await apiRequest('POST', `/v2/users/${openId}/messages`, {
        msg_type: 2,
        markdown: { content: text },
        msg_id: replyMsgId,
        msg_seq: msgSeqCounter++
      })
    },

    async sendTypingIndicator(openId: string, replyMsgId: string, durationSec = 60): Promise<void> {
      const result = await apiRequest('POST', `/v2/users/${openId}/messages`, {
        msg_type: 6,
        input_notify: { input_type: 1, input_second: durationSec },
        msg_id: replyMsgId,
        msg_seq: msgSeqCounter++
      })
      console.log('[qqbot] typing indicator response:', JSON.stringify(result))
    }
  }
}
