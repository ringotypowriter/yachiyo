import { createAppServerClient } from '@yachiyo/shared/appServer/client'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { WebSocket } from 'ws'
import { AppHostBridge } from './hostBridge.ts'
import { listenAppServer, type AppServerListener } from './listener.ts'

test('long operations retain their RPC response while the connection stays healthy', async (t) => {
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<string>()
  const server = await listenAppServer({
    host: new AppHostBridge(),
    subscribe: () => () => {},
    target: {
      status: () => true,
      install: () => {
        started.resolve()
        return finish.promise
      }
    }
  })
  t.after(() => server.close())
  const client = createAppServerClient({
    resolveAddress: async () => server.address,
    async connect(url) {
      const socket = new WebSocket(url)
      await once(socket, 'open')
      return socket
    },
    onReset: () => assert.fail('No reset expected'),
    onConnectionError: started.reject
  })
  t.after(() => client.close())
  await client.call('status')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const result = client.call('install')
  await started.promise
  t.mock.timers.tick(120_001)
  finish.resolve('installed')
  assert.equal(await result, 'installed')
})

test('reconnect resumes missed events without retrying an interrupted mutation', async (t) => {
  let publish: (event: unknown) => void = () => assert.fail('subscription missing')
  let socket: WebSocket
  let writes = 0
  const server = await listenAppServer({
    host: new AppHostBridge(),
    subscribe(listener) {
      publish = listener
      return () => {}
    },
    target: {
      write: () => {
        writes++
        socket.terminate()
      },
      status: () => writes
    }
  })
  t.after(() => server.close())
  const received: number[] = []
  const replayed = Promise.withResolvers<void>()
  const client = createAppServerClient({
    resolveAddress: async () => server.address,
    async connect(url) {
      socket = new WebSocket(url)
      await once(socket, 'open')
      return socket
    },
    onReset: () => assert.fail('An available cursor must resume'),
    onConnectionError: replayed.reject
  })
  t.after(() => client.close())
  client.subscribe((event) => {
    received.push((event as { number: number }).number)
    if (received.length === 2) replayed.resolve()
  })
  await client.call('status')
  publish({ number: 1 })
  await assert.rejects(client.call('write'), /closed/i)
  publish({ number: 2 })
  await client.call('status')
  await replayed.promise
  assert.equal(writes, 1)
  assert.deepEqual(received, [1, 2])
})

test('a new server epoch requires a new snapshot before a queued command can run', async (t) => {
  let writes = 0
  const createServer = (): Promise<AppServerListener> =>
    listenAppServer({
      host: new AppHostBridge(),
      subscribe: () => () => {},
      target: { write: () => ++writes, status: () => writes }
    })
  let server = await createServer()
  t.after(() => server.close())
  let socket: WebSocket
  let reset = false
  const client = createAppServerClient({
    resolveAddress: async () => server.address,
    async connect(url) {
      socket = new WebSocket(url)
      await once(socket, 'open')
      return socket
    },
    onReset: () => {
      reset = true
    },
    onConnectionError: () => {}
  })
  t.after(() => client.close())
  await client.call('status')
  const disconnected = once(socket!, 'close')
  await server.close()
  await disconnected
  server = await createServer()
  await assert.rejects(client.call('write'), /reload and bootstrap/)
  assert.equal(reset, true)
  assert.equal(writes, 0)
})
