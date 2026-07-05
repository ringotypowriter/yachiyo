import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopbackTransportPair } from './loopbackTransport.ts'
import { mergeRpcTargets } from './mergeRpcTargets.ts'
import { createRpcClient } from './rpcClient.ts'
import { serveRpcTarget } from './rpcServer.ts'

class Counter {
  private count = 0

  increment(input: { by: number }): number {
    this.count += input.by
    return this.count
  }

  current(): number {
    return this.count
  }
}

function serveMerged(overrides: object, base: object): ReturnType<typeof createRpcClient> {
  const [serverTransport, clientTransport] = createLoopbackTransportPair()
  serveRpcTarget({ transport: serverTransport, target: mergeRpcTargets(overrides, base) })
  return createRpcClient(clientTransport)
}

test('base class-instance methods keep their this binding', async () => {
  const client = serveMerged({}, new Counter())

  assert.equal(await client.call('increment', [{ by: 2 }]), 2)
  assert.equal(await client.call('increment', [{ by: 40 }]), 42)
  assert.equal(await client.call('current', []), 42)
})

test('override methods win over base methods of the same name', async () => {
  const client = serveMerged({ current: () => -1 }, new Counter())

  assert.equal(await client.call('increment', [{ by: 5 }]), 5)
  assert.equal(await client.call('current', []), -1)
})

test('methods unknown to both targets still reject loudly', async () => {
  const client = serveMerged({ 'host.ping': () => 'pong' }, new Counter())

  assert.equal(await client.call('host.ping', []), 'pong')
  await assert.rejects(client.call('nope', []), /Unknown RPC method: nope/)
})
