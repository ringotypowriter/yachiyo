import type { RpcMessage, RpcTransport } from './rpcTransport.ts'

interface LoopbackEndpointState {
  messageHandlers: Set<(message: RpcMessage) => void>
  closeHandlers: Set<() => void>
}

export function createLoopbackTransportPair(): [RpcTransport, RpcTransport] {
  let closed = false
  const states: [LoopbackEndpointState, LoopbackEndpointState] = [
    { messageHandlers: new Set(), closeHandlers: new Set() },
    { messageHandlers: new Set(), closeHandlers: new Set() }
  ]

  function closeBoth(): void {
    if (closed) {
      return
    }
    closed = true
    for (const state of states) {
      for (const handler of state.closeHandlers) {
        handler()
      }
    }
  }

  function createEndpoint(self: 0 | 1): RpcTransport {
    const peer = states[self === 0 ? 1 : 0]
    return {
      post(message) {
        if (closed) {
          throw new Error('RPC transport closed')
        }
        // Clone at post time, exactly like a MessagePort would, so payloads
        // that cannot cross a real process boundary fail here — before the
        // runtime is ever extracted into its own process.
        const delivered = structuredClone(message)
        queueMicrotask(() => {
          if (closed) {
            return
          }
          for (const handler of peer.messageHandlers) {
            handler(delivered)
          }
        })
      },
      onMessage(handler) {
        states[self].messageHandlers.add(handler)
        return () => {
          states[self].messageHandlers.delete(handler)
        }
      },
      onClose(handler) {
        states[self].closeHandlers.add(handler)
        return () => {
          states[self].closeHandlers.delete(handler)
        }
      },
      close: closeBoth
    }
  }

  return [createEndpoint(0), createEndpoint(1)]
}
