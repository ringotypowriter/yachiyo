import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopbackTransportPair } from './loopbackTransport.ts'
import { createRpcClient, createRpcMethodProxy, type RpcClient } from './rpcClient.ts'
import { serveRpcTarget } from './rpcServer.ts'
import type { RpcTransport } from './rpcTransport.ts'

interface Harness {
  client: RpcClient
  clientTransport: RpcTransport
  disposeServer: () => void
  emitServerEvent: (event: unknown) => void
}

function createHarness(target: object): Harness {
  const [serverTransport, clientTransport] = createLoopbackTransportPair()
  const serverListeners = new Set<(event: unknown) => void>()
  const disposeServer = serveRpcTarget({
    transport: serverTransport,
    target,
    subscribe: (listener) => {
      serverListeners.add(listener)
      return () => {
        serverListeners.delete(listener)
      }
    }
  })
  const client = createRpcClient(clientTransport)

  return {
    client,
    clientTransport,
    disposeServer,
    emitServerEvent: (event) => {
      for (const listener of serverListeners) {
        listener(event)
      }
    }
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('resolves an async target method with its return value', async () => {
  const target = {
    add: async (input: { a: number; b: number }): Promise<{ sum: number }> => ({
      sum: input.a + input.b
    })
  }
  const { client } = createHarness(target)

  const result = await client.call('add', [{ a: 2, b: 40 }])

  assert.deepEqual(result, { sum: 42 })
})

test('resolves a synchronous target method through the same async call path', async () => {
  const target = {
    double: (value: number): number => value * 2
  }
  const { client } = createHarness(target)

  assert.equal(await client.call('double', [21]), 42)
})

test('correlates concurrent calls that resolve out of order', async () => {
  let releaseSlow!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseSlow = resolve
  })
  const target = {
    slow: async (): Promise<string> => {
      await gate
      return 'slow-result'
    },
    fast: async (): Promise<string> => 'fast-result'
  }
  const { client } = createHarness(target)

  const slowPromise = client.call('slow', [])
  const fastPromise = client.call('fast', [])

  assert.equal(await fastPromise, 'fast-result')
  releaseSlow()
  assert.equal(await slowPromise, 'slow-result')
})

test('marshals thrown errors with name and message preserved', async () => {
  const target = {
    explode: async (): Promise<never> => {
      const error = new Error('Unknown thread: thread-9')
      error.name = 'ThreadNotFoundError'
      throw error
    }
  }
  const { client } = createHarness(target)

  await assert.rejects(client.call('explode', []), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Unknown thread: thread-9')
    assert.equal(error.name, 'ThreadNotFoundError')
    return true
  })
})

test('rejects calls to unknown methods', async () => {
  const { client } = createHarness({})

  await assert.rejects(client.call('nope', []), /Unknown RPC method: nope/)
})

test('fans server events out to client subscribers until unsubscribed', async () => {
  const { client, emitServerEvent } = createHarness({})
  const received: unknown[] = []
  const unsubscribe = client.subscribe((event) => received.push(event))

  emitServerEvent({ type: 'thread.updated', threadId: 't-1' })
  emitServerEvent({ type: 'run.started', runId: 'r-1' })
  await settle()

  assert.deepEqual(received, [
    { type: 'thread.updated', threadId: 't-1' },
    { type: 'run.started', runId: 'r-1' }
  ])

  unsubscribe()
  emitServerEvent({ type: 'thread.updated', threadId: 't-2' })
  await settle()

  assert.equal(received.length, 2)
})

test('delivers progress values to onProgress before the call resolves', async () => {
  const target = {
    stream: async (input: { text: string }, onDelta: (delta: string) => void): Promise<string> => {
      onDelta('你')
      onDelta('好')
      return `${input.text}:你好`
    }
  }
  const { client } = createHarness(target)
  const deltas: unknown[] = []

  const result = await client.call('stream', [{ text: 'greeting' }], {
    onProgress: (value) => deltas.push(value)
  })

  assert.deepEqual(deltas, ['你', '好'])
  assert.equal(result, 'greeting:你好')
})

test('clones payloads at the transport boundary so later mutation cannot leak across', async () => {
  let seen: { a: number } | null = null
  const target = {
    record: async (input: { a: number }): Promise<void> => {
      seen = input
    }
  }
  const { client } = createHarness(target)

  const payload = { a: 1 }
  const callPromise = client.call('record', [payload])
  payload.a = 999
  await callPromise

  assert.deepEqual(seen, { a: 1 })
})

test('rejects arguments that cannot survive structured clone', async () => {
  const target = {
    add: async (input: { a: number; b: number }): Promise<number> => input.a + input.b
  }
  const { client } = createHarness(target)

  await assert.rejects(client.call('add', [{ callback: () => 1 }]))
})

test('responds with an error when the return value cannot survive structured clone', async () => {
  const target = {
    leakLiveObject: async (): Promise<unknown> => ({ dispose: () => undefined })
  }
  const { client } = createHarness(target)

  await assert.rejects(client.call('leakLiveObject', []))
})

test('rejects pending and subsequent calls once the transport closes', async () => {
  const gate = new Promise<void>(() => undefined)
  const target = {
    hang: async (): Promise<void> => gate
  }
  const { client, clientTransport } = createHarness(target)

  const pending = client.call('hang', [])
  await settle()
  clientTransport.close()

  await assert.rejects(pending, /RPC transport closed/)
  await assert.rejects(client.call('hang', []), /RPC transport closed/)
})

test('method proxy forwards property calls as RPC calls with stable identity', async () => {
  const target = {
    add: async (input: { a: number; b: number }): Promise<{ sum: number }> => ({
      sum: input.a + input.b
    })
  }
  const { client } = createHarness(target)
  const proxy = createRpcMethodProxy<typeof target>(client)

  assert.deepEqual(await proxy.add({ a: 1, b: 2 }), { sum: 3 })
  assert.equal(proxy.add, proxy.add)
})

test('method proxy is not mistaken for a thenable', async () => {
  const { client } = createHarness({})
  const proxy = createRpcMethodProxy<Record<string, never>>(client)

  const resolved = await Promise.resolve(proxy)

  assert.equal(resolved, proxy)
})

test('server dispose stops event forwarding', async () => {
  const { client, disposeServer, emitServerEvent } = createHarness({})
  const received: unknown[] = []
  client.subscribe((event) => received.push(event))

  emitServerEvent('before-dispose')
  await settle()
  disposeServer()
  emitServerEvent('after-dispose')
  await settle()

  assert.deepEqual(received, ['before-dispose'])
})
