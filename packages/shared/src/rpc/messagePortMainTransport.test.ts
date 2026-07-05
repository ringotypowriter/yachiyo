import assert from 'node:assert/strict'
import test from 'node:test'

import { createRpcClient } from './rpcClient.ts'
import { serveRpcTarget } from './rpcServer.ts'
import { messagePortMainTransport, type MessagePortMainLike } from './messagePortMainTransport.ts'

/**
 * Fake MessageChannelMain pair with the semantics that matter to the adapter:
 * structured-clone on post, delivery gated on start(), close() notifying the
 * peer's close listeners.
 */
function createFakePortPair(): [MessagePortMainLike, MessagePortMainLike] {
  interface PortState {
    messageListeners: Array<(event: { data: unknown }) => void>
    closeListeners: Array<() => void>
    started: boolean
    buffered: unknown[]
  }
  const states: [PortState, PortState] = [
    { messageListeners: [], closeListeners: [], started: false, buffered: [] },
    { messageListeners: [], closeListeners: [], started: false, buffered: [] }
  ]
  let closed = false

  function deliver(to: PortState, data: unknown): void {
    queueMicrotask(() => {
      if (closed) return
      for (const listener of to.messageListeners) {
        listener({ data })
      }
    })
  }

  function createPort(self: 0 | 1): MessagePortMainLike {
    const peer = states[self === 0 ? 1 : 0]
    const port: MessagePortMainLike = {
      postMessage(message) {
        if (closed) return
        const data = structuredClone(message)
        if (peer.started) {
          deliver(peer, data)
        } else {
          peer.buffered.push(data)
        }
      },
      on(event, listener) {
        if (event === 'message') {
          states[self].messageListeners.push(listener as (event: { data: unknown }) => void)
        } else {
          states[self].closeListeners.push(listener as () => void)
        }
        return port
      },
      start() {
        states[self].started = true
        for (const data of states[self].buffered.splice(0)) {
          deliver(states[self], data)
        }
      },
      close() {
        if (closed) return
        closed = true
        for (const listener of peer.closeListeners) {
          listener()
        }
      }
    }
    return port
  }

  return [createPort(0), createPort(1)]
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('serves RPC round-trips across a MessagePortMain-shaped pair', async () => {
  const [serverPort, clientPort] = createFakePortPair()
  serveRpcTarget({
    transport: messagePortMainTransport(serverPort),
    target: {
      add: async (input: { a: number; b: number }): Promise<{ sum: number }> => ({
        sum: input.a + input.b
      })
    }
  })
  const client = createRpcClient(messagePortMainTransport(clientPort))

  assert.deepEqual(await client.call('add', [{ a: 40, b: 2 }]), { sum: 42 })
})

test('payloads are cloned at the port, so later mutation cannot leak across', async () => {
  const [serverPort, clientPort] = createFakePortPair()
  let seen: { a: number } | null = null
  serveRpcTarget({
    transport: messagePortMainTransport(serverPort),
    target: {
      record: async (input: { a: number }): Promise<void> => {
        seen = input
      }
    }
  })
  const client = createRpcClient(messagePortMainTransport(clientPort))

  const payload = { a: 1 }
  const pending = client.call('record', [payload])
  payload.a = 999
  await pending

  assert.deepEqual(seen, { a: 1 })
})

test('peer close rejects pending calls through onClose', async () => {
  const [serverPort, clientPort] = createFakePortPair()
  serveRpcTarget({
    transport: messagePortMainTransport(serverPort),
    target: {
      hang: async (): Promise<void> => new Promise<void>(() => undefined)
    }
  })
  const clientTransport = messagePortMainTransport(clientPort)
  const client = createRpcClient(clientTransport)

  const pending = client.call('hang', [])
  await settle()
  serverPort.close()

  await assert.rejects(pending, /RPC transport closed/)
})

test('onMessage unsubscribe stops delivery to that handler', async () => {
  const [portA, portB] = createFakePortPair()
  const transportB = messagePortMainTransport(portB)
  const received: unknown[] = []
  const off = transportB.onMessage((message) => received.push(message))

  portA.postMessage({ kind: 'rpc:event', payload: 'one' })
  await settle()
  off()
  portA.postMessage({ kind: 'rpc:event', payload: 'two' })
  await settle()

  assert.deepEqual(received, [{ kind: 'rpc:event', payload: 'one' }])
})
