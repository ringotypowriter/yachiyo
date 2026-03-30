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

export interface OneBotGroupMessage {
  messageId: number
  groupId: number
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
type GroupMessageHandler = (msg: OneBotGroupMessage) => void

interface PendingAction {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const RECONNECT_BASE_MS = 3_000
const RECONNECT_CAP_MS = 30_000
const ACTION_TIMEOUT_MS = 30_000

/** Response from the `get_image` OneBot action. */
export interface OneBotImageInfo {
  /** Local file path where NapCat cached the image. */
  file: string
  /** Original filename. */
  filename: string
  /** File size in bytes. */
  size: number
  /** Download URL (may differ from the CQ code URL). */
  url: string
}

export interface OneBotClient {
  connect(): void
  close(): Promise<void>
  /** Register a callback that fires each time the WebSocket connects (including reconnects). */
  onConnect(handler: () => void): void
  onPrivateMessage(handler: PrivateMessageHandler): void
  onGroupMessage(handler: GroupMessageHandler): void
  sendPrivateMessage(userId: number, text: string): Promise<{ messageId: number }>
  sendGroupMessage(groupId: number, text: string): Promise<{ messageId: number }>
  /** Get the bot's own login info (QQ ID + nickname). */
  getLoginInfo(): Promise<{ userId: number; nickname: string }>
  /** Resolve an image file identifier to a local path / download URL. */
  getImage(file: string): Promise<OneBotImageInfo>
  /**
   * Show "对方正在输入..." typing indicator to a private chat user.
   * NapCat extension — only works for C2C (private) messages.
   * @param eventType 1 = typing, 0 = cancel
   */
  setInputStatus(userId: number, eventType: number): Promise<void>
}

export function createOneBotClient(options: OneBotClientOptions): OneBotClient {
  let ws: WebSocket | null = null
  let reconnectDelay = RECONNECT_BASE_MS
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let intentionallyClosed = false
  let echoCounter = 0
  const pendingActions = new Map<string, PendingAction>()
  const privateMessageHandlers: PrivateMessageHandler[] = []
  const groupMessageHandlers: GroupMessageHandler[] = []
  const connectHandlers: Array<() => void> = []

  function connect(): void {
    intentionallyClosed = false
    openConnection()
  }

  function openConnection(): void {
    if (ws) return

    let url = options.url
    if (options.token) {
      const sep = url.includes('?') ? '&' : '?'
      url = `${url}${sep}access_token=${encodeURIComponent(options.token)}`
    }

    try {
      ws = new WebSocket(url)
    } catch (error) {
      console.error('[onebot] failed to create WebSocket:', error)
      scheduleReconnect()
      return
    }

    ws.addEventListener('open', () => {
      console.log(`[onebot] connected to ${options.url}`)
      reconnectDelay = RECONNECT_BASE_MS
      for (const handler of connectHandlers) handler()
    })

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as Record<string, unknown>
        handleMessage(data)
      } catch {
        // Ignore malformed messages.
      }
    })

    ws.addEventListener('close', (event) => {
      ws = null
      if (!intentionallyClosed) {
        console.log(
          `[onebot] connection closed (code=${event.code}, reason=${event.reason || 'none'}), reconnecting in ${reconnectDelay}ms`
        )
        scheduleReconnect()
      }
    })

    ws.addEventListener('error', (event) => {
      const detail = 'message' in event ? (event as { message: string }).message : options.url
      console.error(`[onebot] WebSocket error (${detail})`)
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

    // Group message event.
    if (data.post_type === 'message' && data.message_type === 'group') {
      const sender = data.sender as Record<string, unknown> | undefined
      const msg: OneBotGroupMessage = {
        messageId: data.message_id as number,
        groupId: data.group_id as number,
        userId: data.user_id as number,
        nickname: (sender?.nickname as string) ?? String(data.user_id),
        rawMessage: (data.raw_message as string) ?? '',
        time: data.time as number
      }
      for (const handler of groupMessageHandlers) {
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

    onConnect(handler: () => void): void {
      connectHandlers.push(handler)
    },

    onPrivateMessage(handler: PrivateMessageHandler): void {
      privateMessageHandlers.push(handler)
    },

    onGroupMessage(handler: GroupMessageHandler): void {
      groupMessageHandlers.push(handler)
    },

    async sendPrivateMessage(userId: number, text: string): Promise<{ messageId: number }> {
      const result = (await sendAction('send_private_msg', {
        user_id: userId,
        message: text,
        auto_escape: true
      })) as { message_id: number }
      return { messageId: result.message_id }
    },

    async sendGroupMessage(groupId: number, text: string): Promise<{ messageId: number }> {
      const result = (await sendAction('send_group_msg', {
        group_id: groupId,
        message: text,
        auto_escape: true
      })) as { message_id: number }
      return { messageId: result.message_id }
    },

    async getLoginInfo(): Promise<{ userId: number; nickname: string }> {
      const result = (await sendAction('get_login_info', {})) as {
        user_id: number
        nickname: string
      }
      return { userId: result.user_id, nickname: result.nickname }
    },

    async getImage(file: string): Promise<OneBotImageInfo> {
      const result = (await sendAction('get_image', { file })) as {
        file: string
        filename: string
        size: number
        url: string
      }
      return result
    },

    async setInputStatus(userId: number, eventType: number): Promise<void> {
      await sendAction('set_input_status', {
        user_id: userId,
        event_type: eventType
      })
    }
  }
}
