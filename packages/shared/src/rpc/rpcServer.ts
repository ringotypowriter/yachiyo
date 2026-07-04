import type { RpcErrorShape, RpcMessage, RpcRequestMessage, RpcTransport } from './rpcTransport.ts'

export interface RpcServerOptions {
  transport: RpcTransport
  /** Methods are dispatched by name; anything non-function rejects the call. */
  target: object
  /** Hook the host's event stream; every emitted event is forwarded as `rpc:event`. */
  subscribe?: (listener: (event: unknown) => void) => () => void
}

function toErrorShape(error: unknown): RpcErrorShape {
  if (error instanceof Error) {
    const shape: RpcErrorShape = { name: error.name, message: error.message }
    if (error.stack) {
      shape.stack = error.stack
    }
    return shape
  }
  return { name: 'Error', message: String(error) }
}

export function serveRpcTarget(options: RpcServerOptions): () => void {
  const { transport, target } = options
  let disposed = false

  function post(message: RpcMessage): void {
    if (!disposed) {
      transport.post(message)
    }
  }

  async function dispatch(request: RpcRequestMessage): Promise<void> {
    const method = (target as Record<string, unknown>)[request.method]
    if (typeof method !== 'function') {
      post({
        kind: 'rpc:response',
        id: request.id,
        ok: false,
        error: { name: 'Error', message: `Unknown RPC method: ${request.method}` }
      })
      return
    }

    // Progress convention: when the caller passed onProgress, the emitter is
    // appended as the trailing argument — matching callback-tail signatures
    // like translateStream(input, onDelta).
    const args = request.expectsProgress
      ? [...request.args, (value: unknown) => post({ kind: 'rpc:progress', id: request.id, value })]
      : request.args

    // RPC boundary: every dispatch outcome (including a non-clonable return
    // value, which makes the success post itself throw) must travel back to
    // the caller as a response instead of crashing the host.
    try {
      const value: unknown = await method.apply(target, args)
      post({ kind: 'rpc:response', id: request.id, ok: true, value })
    } catch (error) {
      post({ kind: 'rpc:response', id: request.id, ok: false, error: toErrorShape(error) })
    }
  }

  const offMessage = transport.onMessage((message) => {
    if (message.kind === 'rpc:request') {
      void dispatch(message)
    }
  })
  const offClose = transport.onClose(() => {
    disposed = true
  })
  const unsubscribe = options.subscribe?.((event) => post({ kind: 'rpc:event', payload: event }))

  return () => {
    disposed = true
    offMessage()
    offClose()
    unsubscribe?.()
  }
}
