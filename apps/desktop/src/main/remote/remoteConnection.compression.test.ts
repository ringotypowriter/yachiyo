import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { REMOTE_NOISE_PROLOGUE } from '@yachiyo/shared/remote/wire'

import { decodeRemoteMessage, encodeRemoteMessage } from './messageCodec.ts'
import { HandshakeState } from './noise/handshake.ts'
import { generateKeyPair } from './noise/primitives.ts'
import { NoiseTransport } from './noise/transport.ts'
import {
  RemoteConnection,
  type RemoteConnectionDeps,
  type RemoteSocket
} from './remoteConnection.ts'

class Socket extends EventEmitter implements RemoteSocket {
  bufferedAmount = 0
  frames: Buffer[] = []
  closeCode: number | undefined
  failSend = false
  send(data: Buffer): void {
    if (this.failSend) throw new Error('socket failed')
    this.frames.push(data)
    this.emit('sent')
  }
  close(code: number): void {
    this.closeCode = code
    this.emit('close')
  }
  async sent(count: number): Promise<void> {
    while (this.frames.length < count) await once(this, 'sent')
  }
}

async function connect(
  t: test.TestContext,
  options: { pair?: boolean; payload?: Buffer } = {}
): Promise<{
  socket: Socket
  phone: NoiseTransport
  reply: Buffer
  push: (value: unknown) => void
  persisted: () => number
  dispatched: () => number
}> {
  const socket = new Socket()
  const keyPair = generateKeyPair()
  const token = Buffer.alloc(32, 7)
  let push: (value: unknown) => void = () => {
    throw new Error('not attached')
  }
  let persisted = 0
  let dispatched = 0
  const pairing = {
    pairingId: 'test',
    deviceName: 'phone',
    phoneKey: '',
    mailboxCounter: 0,
    createdAt: ''
  }
  const deps = {
    identity: { keyPair, remoteDeviceId: 'test' },
    store: {
      findByPhoneKey: async () => pairing,
      activeToken: () => token,
      completePairing: async () => {
        persisted++
        return { record: pairing, mailboxSecret: Buffer.alloc(32) }
      },
      touch: async () => {}
    },
    facade: {
      dispatch: async () => {
        dispatched++
        return {}
      }
    },
    hub: () => ({
      attach: (listener: typeof push) => {
        push = listener
        return { close: () => {} }
      }
    }),
    onReady: () => {},
    onClosed: () => {},
    log: () => {}
  } as unknown as RemoteConnectionDeps
  const connection = new RemoteConnection(socket, deps)
  t.after(() => connection.close(1000, 'test complete'))
  const handshake = HandshakeState.initiator({
    pattern: options.pair ? 'IKpsk2' : 'IK',
    prologue: Buffer.from(REMOTE_NOISE_PROLOGUE),
    staticKeyPair: generateKeyPair(),
    remoteStaticKey: keyPair.publicKey,
    psk: options.pair ? token : undefined
  })
  const payload =
    options.payload ??
    Buffer.from(
      JSON.stringify({
        deviceName: 'phone',
        app: 'test',
        version: '1',
        compression: ['gzip']
      })
    )
  socket.emit(
    'message',
    Buffer.concat([Buffer.from([options.pair ? 2 : 1]), handshake.writeMessage(payload)]),
    true
  )
  await socket.sent(1)
  const reply = handshake.readMessage(socket.frames[0]!)
  const phone = new NoiseTransport(handshake.split())
  return {
    socket,
    phone,
    reply,
    push: (value: unknown) => push(value),
    persisted: () => persisted,
    dispatched: () => dispatched
  }
}

test(
  'inbound burst behind compressed input is bounded and discarded on close',
  { timeout: 5000 },
  async (t) => {
    const { socket, phone, dispatched } = await connect(t)
    const request = Buffer.from(
      JSON.stringify({
        kind: 'rpc:request',
        id: 1,
        method: 'hello',
        args: ['a'.repeat(6 * 1024 * 1024)]
      })
    )
    const compressed = await encodeRemoteMessage(request, 'gzip')
    socket.emit('message', phone.encrypt(compressed), true)
    // Keep the event loop occupied by the burst while async inflation is pending.
    await Promise.resolve()
    socket.emit('message', phone.encrypt(request), true)
    socket.emit('message', phone.encrypt(request), true)
    socket.emit('message', phone.encrypt(request), true)
    assert.equal(socket.closeCode, 4409)
    await delay(50)
    assert.equal(dispatched(), 0)
    assert.equal(socket.frames.length, 1)
  }
)

test(
  'queued async compression preserves FIFO encryption and allows raw messages between gzip frames',
  { timeout: 5000 },
  async (t) => {
    const { socket, phone, reply, push } = await connect(t)
    assert.deepEqual(JSON.parse(reply.toString()), { compression: 'gzip' })
    push({ order: 1, text: 'a'.repeat(100_000) })
    push({ order: 2 })
    push({ order: 3, text: 'b'.repeat(100_000) })
    await socket.sent(4)
    const envelopes = socket.frames.slice(1).map((frame) => phone.decrypt(frame))
    assert.deepEqual(
      envelopes.map((frame) => frame[0]),
      [1, 123, 1]
    )
    const messages = await Promise.all(
      envelopes.map(async (frame) =>
        JSON.parse((await decodeRemoteMessage(frame, 'gzip')).toString())
      )
    )
    assert.deepEqual(
      messages.map((message) => message.payload.order),
      [1, 2, 3]
    )
  }
)

test(
  'queued plaintext budget closes connection and discards unsent messages',
  { timeout: 5000 },
  async (t) => {
    const { socket, push } = await connect(t)
    push({ text: 'a'.repeat(6 * 1024 * 1024) })
    push({ text: 'b'.repeat(6 * 1024 * 1024) })
    push({ text: 'c'.repeat(6 * 1024 * 1024) })
    assert.equal(socket.closeCode, 4409)
    push({ ignored: true })
    await delay(50)
    assert.equal(socket.frames.length, 1)
  }
)

test(
  'websocket buffered bytes count toward the same backpressure budget',
  { timeout: 5000 },
  async (t) => {
    const { socket, push } = await connect(t)
    socket.bufferedAmount = 16 * 1024 * 1024
    push({ text: 'small' })
    assert.equal(socket.closeCode, 4409)
    assert.equal(socket.frames.length, 1)
  }
)

test('send failure cancels all queued work', { timeout: 5000 }, async (t) => {
  const { socket, push } = await connect(t)
  socket.failSend = true
  const closed = once(socket, 'close')
  push({ text: 'a'.repeat(100_000) })
  push({ text: 'b'.repeat(100_000) })
  await closed
  assert.equal(socket.closeCode, 4400)
  socket.failSend = false
  push({ ignored: true })
  await delay(30)
  assert.equal(socket.frames.length, 1)
})

test(
  'secret-bearing pairing grants explicitly stay raw even above the threshold',
  { timeout: 5000 },
  async (t) => {
    const { socket, phone, push } = await connect(t)
    push({ type: 'pairing.granted', mailboxSecret: 'secret'.repeat(1000) })
    await socket.sent(2)
    assert.equal(phone.decrypt(socket.frames[1]!)[0], 123)
  }
)

for (const payload of [
  Buffer.alloc(0),
  Buffer.from('historically ignored'),
  Buffer.from('{"compression":["other"]}')
]) {
  test(
    `legacy reconnect payload ${JSON.stringify(
      payload.toString()
    )} preserves empty handshake reply`,
    { timeout: 5000 },
    async (t) => {
      const { reply, socket, phone, push } = await connect(t, { payload })
      assert.equal(reply.length, 0)
      push({ text: 'a'.repeat(2000) })
      await socket.sent(2)
      assert.equal(phone.decrypt(socket.frames[1]!)[0], 123)
    }
  )
}

for (const bytes of [
  Buffer.from([1, 2, 3]),
  Buffer.from('{bad json'),
  Buffer.from('{"kind":"rpc:request","id":1,"method":"hello","args":null}')
]) {
  test(
    `invalid first pairing frame ${bytes.toString('hex')} never persists pairing`,
    { timeout: 5000 },
    async (t) => {
      const { socket, phone, persisted } = await connect(t, { pair: true })
      const closed = once(socket, 'close')
      socket.emit('message', phone.encrypt(bytes), true)
      await closed
      assert.equal(socket.closeCode, 4400)
      assert.equal(persisted(), 0)
    }
  )
}
