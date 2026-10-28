import type { RpcMessage, RpcTransport } from './rpcTransport.ts'
import { decodeRpcMessage, encodeRpcMessage } from './rpcWireCodec.ts'

export const RPC_MAX_FRAME_BYTES = 64 * 1024 * 1024

/** The browser WebSocket surface also implemented by Node's ws package. */
export interface RpcWebSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  binaryType: string
  send(data: string | Uint8Array<ArrayBuffer>): void
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
  socket.binaryType = 'arraybuffer'
  const maxBytes = options.maxBytes ?? RPC_MAX_FRAME_BYTES
  const encoder = new TextEncoder()
  const listeners = new Set<(message: RpcMessage) => void>()
  const closeListeners = new Set<() => void>()
  let closed = false

  const exceedsByteLimit = (frame: string | Uint8Array, budget: number): boolean => {
    if (typeof frame !== 'string') return frame.byteLength > budget
    // Each UTF-16 code unit needs 1–3 UTF-8 bytes. Only count exactly near the limit.
    if (frame.length > budget) return true
    return frame.length * 3 > budget && encoder.encode(frame).byteLength > budget
  }
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
      if (typeof event.data !== 'string' && !(event.data instanceof ArrayBuffer)) {
        throw new Error('Invalid RPC frame')
      }
      const frame = typeof event.data === 'string' ? event.data : new Uint8Array(event.data)
      if (exceedsByteLimit(frame, maxBytes)) throw new Error('Invalid RPC frame')
      message = decodeRpcMessage(frame)
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
      if (exceedsByteLimit(frame, maxBytes - socket.bufferedAmount)) {
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
