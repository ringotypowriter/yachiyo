import { APP_SERVER_PROTOCOL } from '@yachiyo/shared/appServer/protocol'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { createWebSocketRpcTransport } from '@yachiyo/shared/rpc/webSocketRpcTransport'
import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocket } from 'ws'
import { connectAppServer } from './connect.ts'
import { AppHostBridge } from './hostBridge.ts'
import { listenAppServer } from './listener.ts'

test('local app clients authenticate, replay events, and cannot invoke host or prototype methods', async (t) => {
  let publish: (event: unknown) => void = () => assert.fail('subscription missing')
  const host = new AppHostBridge()
  const server = await listenAppServer({
    host,
    target: { echo: (value: unknown) => value },
    adminTarget: { 'host.secret': () => 'private' },
    subscribe: (listener) => {
      publish = listener
      return () => {}
    }
  })
  t.after(() => server.close())
  const admin = await connectAppServer(server.address)
  t.after(() => admin.client.close())
  const address = (await admin.client.call('app.createClientSession', [
    { origin: 'null' }
  ])) as typeof server.address
  const socket = new WebSocket(address.url, { origin: 'null' })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const client = createRpcClient(createWebSocketRpcTransport(socket))
  t.after(() => client.close())
  await assert.rejects(
    client.call('app.authenticate', [{ protocol: 1, token: address.token }]),
    /Invalid input/
  )
  await assert.rejects(client.call('echo', ['before auth']), /Authentication required/)
  await assert.rejects(
    client.call('app.authenticate', [
      { protocol: APP_SERVER_PROTOCOL, token: server.address.token }
    ]),
    /Invalid credentials/
  )
  await client.call('app.authenticate', [{ protocol: APP_SERVER_PROTOCOL, token: address.token }])
  assert.deepEqual(
    await client.call('echo', [new Uint8Array([0, 128, 255])]),
    new Uint8Array([0, 128, 255])
  )
  const values = [
    'attachment:' + '中文😀'.repeat(65536),
    new Uint8Array(1024 * 1024).fill(128).subarray(11),
    { text: 'still JSON', missing: undefined },
    { nested: [new Uint8Array([1, 2, 3]), 'x'.repeat(65536)] }
  ]
  assert.deepEqual(await Promise.all(values.map((value) => client.call('echo', [value]))), values)
  await assert.rejects(client.call('host.secret', []), /authorization required/)
  await assert.rejects(client.call('app.attachHost', []), /authorization required/)
  await assert.rejects(client.call('constructor', []), /Unknown RPC method/)
  const first = (await client.call('app.events', [])) as { cursor: unknown }
  publish({ type: 'run.created', runId: 'task' })
  publish({ type: 'run.completed', runId: 'task' })
  const replay = (await client.call('app.events', [first.cursor])) as {
    events: { event: unknown }[]
    reset: boolean
  }
  assert.equal(replay.reset, false)
  assert.deepEqual(
    replay.events.map((entry) => entry.event),
    [
      { type: 'run.created', runId: 'task' },
      { type: 'run.completed', runId: 'task' }
    ]
  )
  const stale = (await client.call('app.events', [
    { instanceId: 'previous-process', sequence: 0 }
  ])) as { reset: boolean }
  assert.equal(stale.reset, true)
})

test('native capabilities detach independently from the running app server', async (t) => {
  const host = new AppHostBridge()
  const detached = Promise.withResolvers<void>()
  let task = 'running'
  const server = await listenAppServer({
    host,
    target: {
      status: () => task,
      finish: () => {
        task = 'completed'
      }
    },
    subscribe: () => () => {},
    onHostDisconnected: detached.resolve
  })
  t.after(() => server.close())
  const desktop = await connectAppServer(server.address, {
    native: (value: string) => `native:${value}`
  })
  assert.equal(await host.call('native', ['ok']), 'native:ok')
  const second = await connectAppServer(server.address)
  t.after(() => second.client.close())
  await assert.rejects(second.client.call('app.attachHost', []), /already attached/)
  desktop.client.close()
  await detached.promise
  await assert.rejects(host.call('native', []), /requires an attached desktop/)
  assert.equal(await second.client.call('status', []), 'running')
  await second.client.call('finish', [])
  assert.equal(await second.client.call('status', []), 'completed')
})
