import type { Socket } from 'node:net'
import { z } from 'zod'

import type { RpcMessage, RpcTransport } from './rpcTransport.ts'

const messageSchema = z.union([
  z.object({
    kind: z.literal('rpc:request'),
    id: z.number().int().positive(),
    method: z.string().min(1),
    args: z.array(z.unknown()),
    expectsProgress: z.boolean().optional()
  }),
  z.object({
    kind: z.literal('rpc:response'),
    id: z.number().int().positive(),
    ok: z.literal(true),
    value: z.unknown().optional()
  }),
  z.object({
    kind: z.literal('rpc:response'),
    id: z.number().int().positive(),
    ok: z.literal(false),
    error: z.object({ name: z.string(), message: z.string(), stack: z.string().optional() })
  }),
  z.object({
    kind: z.literal('rpc:progress'),
    id: z.number().int().positive(),
    value: z.unknown()
  }),
  z.object({ kind: z.literal('rpc:event'), payload: z.unknown() })
])

const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Newline-delimited RPC for a local socket. A slow or malformed peer is disconnected. */
export function createSocketRpcTransport(socket: Socket): RpcTransport {
  const listeners = new Set<(message: RpcMessage) => void>()
  const closeListeners = new Set<() => void>()
  let buffer = ''
  let closed = false
  socket.setEncoding('utf8')
  const close = (): void => {
    if (closed) return
    closed = true
    socket.destroy()
    for (const listener of closeListeners) listener()
    listeners.clear()
    closeListeners.clear()
  }
  socket.on('error', close)
  socket.on('close', close)
  socket.on('end', close)
  socket.on('data', (chunk: string) => {
    buffer += chunk
    try {
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error('RPC frame too large')
        const message = messageSchema.parse(JSON.parse(frame)) as RpcMessage
        for (const listener of listeners) listener(message)
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw new Error('RPC frame too large')
    } catch {
      close()
    }
  })
  return {
    post(message): void {
      if (closed) throw new Error('RPC transport closed')
      const frame = JSON.stringify(message) + '\n'
      if (Buffer.byteLength(frame) + socket.writableLength > MAX_FRAME_BYTES) {
        close()
        throw new Error('Local RPC peer exceeded the output buffer limit')
      }
      socket.write(frame)
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
    close
  }
}
