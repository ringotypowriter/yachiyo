import type { RpcMessage, RpcTransport } from './rpcTransport.ts'
import { decodeRpcMessage, encodeRpcMessage } from './rpcWireCodec.ts'

export const RPC_MAX_FRAME_BYTES = 64 * 1024 * 1024

/** The browser WebSocket surface also implemented by Node's ws package. */
export interface RpcWebSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close' | 'error', listener: () => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'close' | 'error', listener: () => void): void
}

export function createWebSocketRpcTransport(
  socket: RpcWebSocket,
  options: { maxBytes?: number } = {}
): RpcTransport {
  if (socket.readyState !== 1) throw new Error('RPC WebSocket must be open')
  const maxBytes = options.maxBytes ?? RPC_MAX_FRAME_BYTES
  const encoder = new TextEncoder()
  const listeners = new Set<(message: RpcMessage) => void>()
  const closeListeners = new Set<() => void>()
  let closed = false

  const dispose = (): void => {
    if (closed) return
    closed = true
    socket.removeEventListener('message', receive)
    socket.removeEventListener('close', dispose)
    socket.removeEventListener('error', fail)
    for (const listener of closeListeners) listener()
    listeners.clear()
    closeListeners.clear()
  }
  const fail = (): void => {
    dispose()
    socket.close(1008, 'Invalid RPC transport')
  }
  const receive = (event: { data: unknown }): void => {
    let message: RpcMessage
    try {
      if (typeof event.data !== 'string' || encoder.encode(event.data).byteLength > maxBytes) {
        throw new Error('Invalid RPC frame')
      }
      message = decodeRpcMessage(event.data)
      for (const listener of listeners) listener(message)
    } catch {
      fail()
      return
    }
  }
  socket.addEventListener('message', receive)
  socket.addEventListener('close', dispose)
  socket.addEventListener('error', fail)

  return {
    post(message) {
      if (closed || socket.readyState !== 1) throw new Error('RPC transport closed')
      const frame = encodeRpcMessage(message)
      if (encoder.encode(frame).byteLength + socket.bufferedAmount > maxBytes) {
        fail()
        throw new Error('RPC peer exceeded the output buffer limit')
      }
      socket.send(frame)
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onClose(listener) {
      if (closed) listener()
      else closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    close() {
      dispose()
      socket.close(1000, 'RPC client closed')
    }
  }
}
