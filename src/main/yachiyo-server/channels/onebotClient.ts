/**
 * Thin OneBot v11 WebSocket client using Node 22's built-in WebSocket.
 *
 * Handles connection, auto-reconnect with exponential backoff, event dispatch,
 * and request/response matching via echo IDs. No external dependencies.
 */

export interface OneBotPrivateMessage {
  messageId: number
  userId: number
  nickname: string
  rawMessage: string
  time: number
}

export interface OneBotClientOptions {
  /** Forward WebSocket URL (e.g. "ws://localhost:3001"). */
  url: string
  /** Optional auth token (sent as Authorization header). */
  token?: string
}

type PrivateMessageHandler = (msg: OneBotPrivateMessage) => void

interface PendingAction {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const RECONNECT_BASE_MS = 3_000
const RECONNECT_CAP_MS = 30_000
const ACTION_TIMEOUT_MS = 30_000

export interface OneBotClient {
  connect(): void
  close(): Promise<void>
  onPrivateMessage(handler: PrivateMessageHandler): void
  sendPrivateMessage(userId: number, text: string): Promise<{ messageId: number }>
}

export function createOneBotClient(options: OneBotClientOptions): OneBotClient {
  let ws: WebSocket | null = null
  let reconnectDelay = RECONNECT_BASE_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let intentionallyClosed = false
  let echoCounter = 0
  const pendingActions = new Map<string, PendingAction>()
  const privateMessageHandlers: PrivateMessageHandler[] = []

  function connect(): void {
    intentionallyClosed = false
    openConnection()
  }

  function openConnection(): void {
    if (ws) return

    const protocols = options.token ? [`Bearer.${options.token}`] : undefined

    try {
      ws = new WebSocket(options.url, protocols)
    } catch (error) {
      console.error('[onebot] failed to create WebSocket:', error)
      scheduleReconnect()
      return
    }

    ws.addEventListener('open', () => {
      console.log(`[onebot] connected to ${options.url}`)
      reconnectDelay = RECONNECT_BASE_MS
    })

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>
        handleMessage(data)
      } catch {
        // Ignore malformed messages.
      }
    })

    ws.addEventListener('close', () => {
      ws = null
      if (!intentionallyClosed) {
        console.log(`[onebot] connection closed, reconnecting in ${reconnectDelay}ms`)
        scheduleReconnect()
      }
    })

    ws.addEventListener('error', (event) => {
      console.error('[onebot] WebSocket error:', event)
    })
  }

  function scheduleReconnect(): void {
    if (reconnectTimer || intentionallyClosed) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_CAP_MS)
      openConnection()
    }, reconnectDelay)
  }

  function handleMessage(data: Record<string, unknown>): void {
    // Action response (has echo field).
    if ('echo' in data && typeof data.echo === 'string') {
      const pending = pendingActions.get(data.echo)
      if (pending) {
        pendingActions.delete(data.echo)
        clearTimeout(pending.timer)
        if (data.status === 'ok') {
          pending.resolve(data.data)
        } else {
          pending.reject(new Error(`OneBot action failed: ${JSON.stringify(data)}`))
        }
      }
      return
    }

    // Meta event (heartbeat, lifecycle) — just log.
    if (data.post_type === 'meta_event') {
      return
    }

    // Private message event.
    if (data.post_type === 'message' && data.message_type === 'private') {
      const sender = data.sender as Record<string, unknown> | undefined
      const msg: OneBotPrivateMessage = {
        messageId: data.message_id as number,
        userId: data.user_id as number,
        nickname: (sender?.nickname as string) ?? String(data.user_id),
        rawMessage: (data.raw_message as string) ?? '',
        time: data.time as number
      }
      for (const handler of privateMessageHandlers) {
        handler(msg)
      }
    }
  }

  function sendAction(action: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('[onebot] not connected'))
        return
      }

      const echo = `yachiyo-${++echoCounter}`
      const timer = setTimeout(() => {
        pendingActions.delete(echo)
        reject(new Error(`[onebot] action "${action}" timed out after ${ACTION_TIMEOUT_MS}ms`))
      }, ACTION_TIMEOUT_MS)

      pendingActions.set(echo, { resolve, reject, timer })
      ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  return {
    connect,

    async close(): Promise<void> {
      intentionallyClosed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      for (const [echo, pending] of pendingActions) {
        clearTimeout(pending.timer)
        pending.reject(new Error('[onebot] client closing'))
        pendingActions.delete(echo)
      }
      if (ws) {
        ws.close()
        ws = null
      }
    },

    onPrivateMessage(handler: PrivateMessageHandler): void {
      privateMessageHandlers.push(handler)
    },

    async sendPrivateMessage(userId: number, text: string): Promise<{ messageId: number }> {
      const result = (await sendAction('send_private_msg', {
        user_id: userId,
        message: text,
        auto_escape: true
      })) as { message_id: number }
      return { messageId: result.message_id }
    }
  }
}
