import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createLoopbackTransportPair } from '@yachiyo/shared/rpc/loopbackTransport'
import { mergeRpcTargets } from '@yachiyo/shared/rpc/mergeRpcTargets'
import { createRpcClient, createRpcMethodProxy } from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'

// The Electron entry cannot be imported in a Node test. Guard its actual wiring
// as well as exercising the server-method namespace through the real RPC stack.
const gatewaySource = readFileSync(new URL('./registerYachiyoGateway.ts', import.meta.url), 'utf8')

test('utility admission close uses the server proxy, not host-level live services', () => {
  assert.ok(/rpc\(\)\.closeRunAdmissionAndGetActiveRunIds\(ownerId\)/.test(gatewaySource))
})

test('utility admission reopen uses the captured runtime server proxy', () => {
  assert.ok(/runtime\.proxy\.openRunAdmission\(ownerId\)/.test(gatewaySource))
})

test('server admission methods round-trip owner and active run snapshot through merged RPC', async (t) => {
  class AdmissionServer {
    ownerId: string | undefined
    activeRunIds = ['run-active']

    closeRunAdmissionAndGetActiveRunIds(ownerId: string): string[] {
      this.ownerId = ownerId
      return [...this.activeRunIds]
    }

    openRunAdmission(ownerId: string): void {
      if (this.ownerId === ownerId) this.ownerId = undefined
    }
  }

  const server = new AdmissionServer()
  const [serverTransport, clientTransport] = createLoopbackTransportPair()
  const stop = serveRpcTarget({
    transport: serverTransport,
    target: mergeRpcTargets({ 'host.ping': () => 'pong' }, server)
  })
  const client = createRpcClient(clientTransport)
  t.after(() => {
    client.close()
    stop()
  })
  const proxy = createRpcMethodProxy<AdmissionServer>(client)

  await assert.rejects(
    client.call('host.closeRunAdmissionAndGetActiveRunIds', ['install-1']),
    /Unknown RPC method: host\.closeRunAdmissionAndGetActiveRunIds/
  )
  assert.deepEqual(await proxy.closeRunAdmissionAndGetActiveRunIds('install-1'), ['run-active'])
  assert.equal(server.ownerId, 'install-1')
  await proxy.openRunAdmission('foreign-owner')
  assert.equal(server.ownerId, 'install-1')
  await proxy.openRunAdmission('install-1')
  assert.equal(server.ownerId, undefined)
})
