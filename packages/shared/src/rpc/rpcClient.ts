import type { RpcErrorShape, RpcRequestMessage, RpcTransport } from './rpcTransport.ts'

export interface RpcCallOptions {
  /** Receives `rpc:progress` values; the server gets the emitter appended as trailing argument. */
  onProgress?: (value: unknown) => void
}

export interface RpcClient {
  call(method: string, args: unknown[], options?: RpcCallOptions): Promise<unknown>
  subscribe(listener: (event: unknown) => void): () => void
  close(): void
}

/**
 * Maps a host interface to its RPC-proxied shape: every method returns a
 * Promise. Methods with callback parameters (e.g. translateStream) are mapped
 * naively — call those through client.call with onProgress instead.
 */
export type RpcMethods<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer TArgs
  ) => infer TResult
    ? (...args: TArgs) => Promise<Awaited<TResult>>
    : never
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onProgress: ((value: unknown) => void) | undefined
}

function toError(shape: RpcErrorShape): Error {
  const error = new Error(shape.message)
  error.name = shape.name
  if (shape.stack) {
    ;(error as Error & { remoteStack?: string }).remoteStack = shape.stack
  }
  return error
}

export function createRpcClient(transport: RpcTransport): RpcClient {
  const pending = new Map<number, PendingCall>()
  const eventListeners = new Set<(event: unknown) => void>()
  let nextId = 1
  let closed = false

  transport.onMessage((message) => {
    if (message.kind === 'rpc:response') {
      const call = pending.get(message.id)
      if (!call) {
        throw new Error(`RPC response for unknown request id: ${message.id}`)
      }
      pending.delete(message.id)
      if (message.ok) {
        call.resolve(message.value)
      } else {
        call.reject(toError(message.error))
      }
      return
    }
    if (message.kind === 'rpc:progress') {
      const call = pending.get(message.id)
      if (!call) {
        throw new Error(`RPC progress for unknown request id: ${message.id}`)
      }
      if (!call.onProgress) {
        throw new Error(`RPC progress for request ${message.id} which did not expect progress`)
      }
      call.onProgress(message.value)
      return
    }
    if (message.kind === 'rpc:event') {
      for (const listener of eventListeners) {
        listener(message.payload)
      }
    }
  })

  transport.onClose(() => {
    closed = true
    for (const call of pending.values()) {
      call.reject(new Error('RPC transport closed'))
    }
    pending.clear()
  })

  return {
    call(method, args, options) {
      if (closed) {
        return Promise.reject(new Error('RPC transport closed'))
      }
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress: options?.onProgress })
        const request: RpcRequestMessage = { kind: 'rpc:request', id, method, args }
        if (options?.onProgress) {
          request.expectsProgress = true
        }
        try {
          transport.post(request)
        } catch (error) {
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    subscribe(listener) {
      eventListeners.add(listener)
      return () => {
        eventListeners.delete(listener)
      }
    },
    close() {
      transport.close()
    }
  }
}

export function createRpcMethodProxy<T extends object>(client: RpcClient): RpcMethods<T> {
  const methods: Record<string | symbol, unknown> = {}
  return new Proxy(methods, {
    get(cache, property) {
      // Guard against thenable coercion: awaiting the proxy itself must not
      // turn into an RPC call named "then".
      if (property === 'then' || typeof property !== 'string') {
        return undefined
      }
      cache[property] ??= (...args: unknown[]) => client.call(property, args)
      return cache[property]
    }
  }) as RpcMethods<T>
}
