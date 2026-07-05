import type { RpcMessage, RpcTransport } from './rpcTransport.ts'

/**
 * Structural subset of Electron's MessagePortMain. Both ends of a
 * MessageChannelMain satisfy it — in the main process and inside a
 * utilityProcess (ports received via parentPort message events) — so one
 * adapter covers both sides of the runtime extraction. Typed structurally so
 * it stays unit-testable without Electron.
 */
export interface MessagePortMainLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (messageEvent: { data: unknown }) => void): this
  on(event: 'close', listener: () => void): this
  start(): void
  close(): void
}

/**
 * Adapts a MessagePortMain-shaped port to RpcTransport. The port is started
 * immediately, so attach handlers (createRpcClient / serveRpcTarget) in the
 * same tick to avoid dropping early messages.
 */
export function messagePortMainTransport(port: MessagePortMainLike): RpcTransport {
  const messageHandlers = new Set<(message: RpcMessage) => void>()
  const closeHandlers = new Set<() => void>()

  port.on('message', (messageEvent) => {
    for (const handler of messageHandlers) {
      handler(messageEvent.data as RpcMessage)
    }
  })
  port.on('close', () => {
    for (const handler of closeHandlers) {
      handler()
    }
  })
  port.start()

  return {
    post: (message) => port.postMessage(message),
    onMessage: (handler) => {
      messageHandlers.add(handler)
      return () => {
        messageHandlers.delete(handler)
      }
    },
    onClose: (handler) => {
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
    close: () => port.close()
  }
}
