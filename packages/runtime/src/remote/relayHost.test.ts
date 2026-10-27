import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'

import { RelayHost, relayServerOrigin } from './relayHost.ts'

test('rejects unsafe relay origins without leaking credentials', () => {
  assert.equal(relayServerOrigin('https://relay.example/'), 'https://relay.example')
  assert.equal(relayServerOrigin('wss://relay.example'), 'https://relay.example')
  for (const input of [
    'http://relay.example',
    'https://u:p@relay.example',
    'https://relay.example/?key=x',
    'https://relay.example/#x',
    'https://relay.example/extra'
  ]) {
    assert.throws(() => relayServerOrigin(input))
  }
})

test('host opens individual virtual sockets and forwards UUID-prefixed binary without changing Noise bytes', async () => {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const host = new RelayHost({
    server: 'https://relay.example',
    hostId: 'mac-1',
    key: 'A'.repeat(43),
    connect: (_url, headers) => new WebSocket(`ws://127.0.0.1:${port}`, { headers }),
    accept(socket) {
      socket.on('message', (bytes) => {
        socket.send(bytes)
      })
    },
    log: () => undefined
  })
  const incoming = once(server, 'connection')
  await host.start()
  const [socket] = (await incoming) as [WebSocket]
  const session = '12345678-1234-4234-8234-123456789abc'
  socket.send(JSON.stringify({ type: 'connect', session, phone: 'phone-1' }))
  const [opening] = await once(socket, 'message')
  assert.deepEqual(JSON.parse(opening.toString()), { type: 'open', session })
  const prefix = Buffer.from(session.replaceAll('-', ''), 'hex')
  const payload = Buffer.from([0, 1, 2, 255])
  socket.send(Buffer.concat([prefix, payload]))
  const [echo] = await once(socket, 'message')
  assert.deepEqual(echo, Buffer.concat([prefix, payload]))
  await host.stop()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('an expired bootstrap cannot open new sessions while an existing virtual stream survives', async () => {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  let expired = false
  let accepted = 0
  const host = new RelayHost({
    server: 'https://relay.example',
    hostId: 'mac-1',
    key: 'A'.repeat(43),
    connect: (_url, headers) => new WebSocket(`ws://127.0.0.1:${port}`, { headers }),
    authorizePhone: () => !expired,
    accept: () => {
      accepted++
    },
    log: () => undefined
  })
  const incoming = once(server, 'connection')
  try {
    await host.start()
    const [socket] = (await incoming) as [WebSocket]
    socket.send(
      JSON.stringify({
        type: 'connect',
        session: '12345678-1234-4234-8234-123456789abc',
        phone: 'bootstrap'
      })
    )
    assert.equal(JSON.parse((await once(socket, 'message'))[0].toString()).type, 'open')
    expired = true
    socket.send(
      JSON.stringify({
        type: 'connect',
        session: '12345678-1234-4234-8234-123456789abd',
        phone: 'bootstrap'
      })
    )
    assert.equal(JSON.parse((await once(socket, 'message'))[0].toString()).type, 'close')
    assert.equal(accepted, 1)
  } finally {
    await host.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
