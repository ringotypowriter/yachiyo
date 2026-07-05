import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopbackTransportPair } from './loopbackTransport.ts'
import { createRpcClient } from './rpcClient.ts'
import { serveRpcTarget } from './rpcServer.ts'

/**
 * The extraction plan relies on one port pair carrying RPC in BOTH directions:
 * the gateway calls the runtime (requests →) while the runtime calls back into
 * main for Electron-only services (← requests). These tests pin down that the
 * protocol is symmetric: each endpoint hosts a server and a client on the same
 * transport without id cross-talk.
 */
test('both endpoints call each other concurrently without id cross-talk', async () => {
  const [mainTransport, runtimeTransport] = createLoopbackTransportPair()
  serveRpcTarget({
    transport: mainTransport,
    target: {
      notify: async (input: { title: string }): Promise<string> => `notified:${input.title}`
    }
  })
  serveRpcTarget({
    transport: runtimeTransport,
    target: { ping: async (): Promise<string> => 'pong' }
  })
  const gatewayClient = createRpcClient(mainTransport)
  const runtimeClient = createRpcClient(runtimeTransport)

  const [forward, reverse] = await Promise.all([
    gatewayClient.call('ping', []),
    runtimeClient.call('notify', [{ title: 'run finished' }])
  ])

  assert.equal(forward, 'pong')
  assert.equal(reverse, 'notified:run finished')
})

test('a reverse call can be issued from inside a forward call', async () => {
  // The real shape: the agent loop (runtime) needs a main-process service
  // while it is still handling a gateway request.
  const notified: string[] = []
  const [mainTransport, runtimeTransport] = createLoopbackTransportPair()
  serveRpcTarget({
    transport: mainTransport,
    target: {
      notify: async (input: { title: string }): Promise<void> => {
        notified.push(input.title)
      }
    }
  })
  const runtimeClient = createRpcClient(runtimeTransport)
  serveRpcTarget({
    transport: runtimeTransport,
    target: {
      sendChat: async (input: { content: string }): Promise<string> => {
        await runtimeClient.call('notify', [{ title: `reply to ${input.content}` }])
        return 'accepted'
      }
    }
  })
  const gatewayClient = createRpcClient(mainTransport)

  const result = await gatewayClient.call('sendChat', [{ content: '你好' }])

  assert.equal(result, 'accepted')
  assert.deepEqual(notified, ['reply to 你好'])
})
