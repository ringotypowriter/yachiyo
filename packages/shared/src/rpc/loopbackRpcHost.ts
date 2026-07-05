import { createLoopbackTransportPair } from './loopbackTransport.ts'
import {
  createRpcClient,
  createRpcMethodProxy,
  type RpcClient,
  type RpcMethods
} from './rpcClient.ts'
import { serveRpcTarget } from './rpcServer.ts'

export interface LoopbackRpcHostOptions {
  /** Hook the target's event stream; every emitted event reaches client subscribers. */
  subscribe?: (listener: (event: unknown) => void) => () => void
}

export interface LoopbackRpcHost<T extends object> {
  /** Typed method proxy; every call crosses the structured-clone boundary. */
  proxy: RpcMethods<T>
  /** Raw client for progress-callback calls (client.call with onProgress) and events. */
  client: RpcClient
  dispose: () => void
}

/**
 * Serves a target over an in-process loopback transport and returns the
 * client side. Because the loopback transport structured-clones at post time,
 * every call rehearses the real MessagePort boundary while everything still
 * runs in-process.
 */
export function createLoopbackRpcHost<T extends object>(
  target: T,
  options: LoopbackRpcHostOptions = {}
): LoopbackRpcHost<T> {
  const [serverTransport, clientTransport] = createLoopbackTransportPair()
  const disposeServer = serveRpcTarget({
    transport: serverTransport,
    target,
    subscribe: options.subscribe
  })
  const client = createRpcClient(clientTransport)

  return {
    proxy: createRpcMethodProxy<T>(client),
    client,
    dispose: () => {
      clientTransport.close()
      disposeServer()
    }
  }
}
