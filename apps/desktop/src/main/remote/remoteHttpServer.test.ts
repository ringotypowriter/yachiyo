import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'

import { WebSocket } from 'ws'

import { REMOTE_WS_PATH } from '@yachiyo/shared/remote/wire'

import { startRemoteHttpServer, type RemoteHttpServer } from './remoteHttpServer.ts'

async function startServer(t: test.TestContext): Promise<RemoteHttpServer> {
  const server = await startRemoteHttpServer({
    host: '127.0.0.1',
    port: 0,
    pingIntervalMs: 30,
    onConnection: () => {}
  })
  t.after(() => server.close())
  return server
}

function connect(server: RemoteHttpServer, autoPong: boolean): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${server.port}${REMOTE_WS_PATH}`, { autoPong })
}

test('keeps a socket that answers pings open across ping ticks', async (t) => {
  const server = await startServer(t)
  const socket = connect(server, true)
  t.after(() => socket.terminate())
  await once(socket, 'open')
  const closed = once(socket, 'close').then(() => {
    throw new Error('server closed a socket that answers pings')
  })

  // Each ping arrives a tick after the previous pong, so three pings span three liveness checks.
  for (let pings = 0; pings < 3; pings += 1) await Promise.race([once(socket, 'ping'), closed])

  assert.equal(socket.readyState, WebSocket.OPEN)
})

test('terminates a socket that stops answering pings', async (t) => {
  const server = await startServer(t)
  const socket = connect(server, false)
  await once(socket, 'open')

  await once(socket, 'close')

  assert.equal(socket.readyState, WebSocket.CLOSED)
})

test('skips pings while the phone is sending frames, and pings again once it stops', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let now = 0
  let serverSocket: WebSocket
  const server = await startRemoteHttpServer({
    host: '127.0.0.1',
    port: 0,
    pingIntervalMs: 30,
    now: () => now,
    onConnection: (socket) => {
      serverSocket = socket
    }
  })
  t.after(() => server.close())
  const socket = connect(server, false)
  t.after(() => socket.terminate())
  await once(socket, 'open')
  let pinged = false
  socket.on('ping', () => {
    pinged = true
  })

  // Wait for frame receipt before advancing liveness checks, independent of CI scheduling.
  for (let frame = 0; frame < 15; frame += 1) {
    const received = once(serverSocket!, 'message')
    socket.send(Buffer.from([frame]))
    await received
    now += 10
    t.mock.timers.tick(30)
  }
  assert.equal(pinged, false)
  assert.equal(socket.readyState, WebSocket.OPEN)

  const ping = once(socket, 'ping')
  now += 30
  t.mock.timers.tick(30)
  await ping
  const closed = once(socket, 'close')
  now += 30
  t.mock.timers.tick(30)
  await closed
  assert.equal(pinged, true)
})
