import { createRpcClient, type RpcCallOptions, type RpcClient } from '../rpc/rpcClient.ts'
import { createWebSocketRpcTransport, type RpcWebSocket } from '../rpc/webSocketRpcTransport.ts'
import {
  APP_SERVER_PROTOCOL,
  type AppEventCursor,
  type AppEventEnvelope,
  type AppEventSubscription,
  type AppServerAddress
} from './protocol.ts'

export interface AppServerClient {
  call(method: string, args?: unknown[], options?: RpcCallOptions): Promise<unknown>
  subscribe(listener: (event: unknown) => void): () => void
  close(): void
}

/** Browser-compatible client. Calls are never retried; only event subscriptions reconnect. */
export function createAppServerClient(options: {
  resolveAddress: () => Promise<AppServerAddress>
  connect: (url: string) => Promise<RpcWebSocket>
  onReset: () => void
  onConnectionError: (error: Error) => void
  onConnected?: () => void
  timeoutMs?: number
}): AppServerClient {
  const listeners = new Set<(event: unknown) => void>()
  let cursor: AppEventCursor | undefined
  let client: RpcClient | undefined
  let connecting: Promise<RpcClient> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let failures = 0

  const deliver = (envelope: AppEventEnvelope): void => {
    if (
      cursor &&
      envelope.cursor.instanceId === cursor.instanceId &&
      envelope.cursor.sequence <= cursor.sequence
    )
      return
    cursor = envelope.cursor
    for (const listener of listeners)
      listener({ ...(envelope.event as object), streamCursor: envelope.cursor })
  }

  const scheduleReconnect = (): void => {
    if (closed || retry) return
    retry = setTimeout(
      () => {
        retry = undefined
        void ready().catch(options.onConnectionError)
      },
      Math.min(500 * 2 ** Math.min(failures++, 4), 5000)
    )
  }

  const timedCall = async (
    rpc: RpcClient,
    method: string,
    args: unknown[],
    callOptions?: RpcCallOptions,
    timeoutMs = options.timeoutMs
  ): Promise<unknown> => {
    const deadline = timeoutMs === undefined ? undefined : setTimeout(() => rpc.close(), timeoutMs)
    try {
      return await rpc.call(method, args, callOptions)
    } finally {
      clearTimeout(deadline)
    }
  }

  const ready = (): Promise<RpcClient> => {
    if (closed) return Promise.reject(new Error('App server client closed'))
    if (client) return Promise.resolve(client)
    if (connecting) return connecting
    connecting = (async () => {
      const address = await options.resolveAddress()
      if (address.protocol !== APP_SERVER_PROTOCOL)
        throw new Error('Incompatible app server protocol; restart the server')
      const socket = await options.connect(address.url)
      const transport = createWebSocketRpcTransport(socket)
      const rpc = createRpcClient(transport)
      if (closed) {
        rpc.close()
        throw new Error('App server client closed')
      }
      transport.onClose(() => {
        if (client === rpc) client = undefined
        scheduleReconnect()
      })
      const queued: AppEventEnvelope[] = []
      let replaying = true
      rpc.subscribe((event) => {
        const envelope = event as AppEventEnvelope
        if (replaying) queued.push(envelope)
        else deliver(envelope)
      })
      try {
        await timedCall(
          rpc,
          'app.authenticate',
          [{ protocol: APP_SERVER_PROTOCOL, token: address.token }],
          undefined,
          5000
        )
        const replay = (await timedCall(
          rpc,
          'app.events',
          [cursor],
          undefined,
          5000
        )) as AppEventSubscription
        if (replay.reset) {
          // Pending commands were created against an obsolete snapshot. A fresh client
          // must bootstrap before they can be submitted to a different server epoch.
          closed = true
          if (retry) clearTimeout(retry)
          options.onReset()
          throw new Error('App server state changed; reload and bootstrap before sending commands')
        }
        if (!cursor || replay.reset) cursor = replay.cursor
        for (const envelope of replay.events) deliver(envelope)
        for (const envelope of queued) deliver(envelope)
        cursor = cursor && cursor.sequence > replay.cursor.sequence ? cursor : replay.cursor
        replaying = false
        client = rpc
        failures = 0
        options.onConnected?.()
        return rpc
      } catch (error) {
        rpc.close()
        throw error
      }
    })().finally(() => {
      connecting = undefined
    })
    void connecting.catch(() => scheduleReconnect())
    return connecting
  }

  return {
    async call(method, args = [], callOptions) {
      return timedCall(await ready(), method, args, callOptions)
    },
    subscribe(listener) {
      listeners.add(listener)
      void ready().catch(options.onConnectionError)
      return () => listeners.delete(listener)
    },
    close() {
      closed = true
      if (retry) clearTimeout(retry)
      client?.close()
      listeners.clear()
    }
  }
}

export function openBrowserAppSocket(url: string): Promise<WebSocket> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1') {
    return Promise.reject(new Error('App server must use a loopback WebSocket'))
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error('App server connection timed out'))
    }, 5000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout)
        resolve(socket)
      },
      { once: true }
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout)
        reject(new Error('App server connection failed'))
      },
      { once: true }
    )
  })
}
