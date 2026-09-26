import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { constants, createInflateRaw } from 'node:zlib'

import { REMOTE_MAX_MESSAGE_BYTES } from '@yachiyo/shared/remote/methods'
import {
  REMOTE_NOISE_PROLOGUE,
  REMOTE_STREAM_DEFLATE_MESSAGE_TAG
} from '@yachiyo/shared/remote/wire'

import { createStreamDeflateEncoder } from './messageCodec.ts'
import { HandshakeState } from './noise/handshake.ts'
import { generateKeyPair } from './noise/primitives.ts'
import { NoiseTransport } from './noise/transport.ts'
import {
  RemoteConnection,
  type RemoteConnectionDeps,
  type RemoteSocket
} from './remoteConnection.ts'
import { createStreamInflateDecoder } from './testing/streamInflate.ts'

class Socket extends EventEmitter implements RemoteSocket {
  bufferedAmount = 0
  frames: Buffer[] = []
  closeCode: number | undefined
  send(data: Buffer): void {
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

const HELLO = {
  protocolVersion: 1,
  remoteDeviceId: '0123456789abcdef0123456789abcdef',
  deviceName: 'Test Mac',
  appVersion: '0.0.0-test',
  epoch: 'epoch-1',
  activeRunEnterBehavior: 'enter-steers' as const
}

async function connect(
  t: test.TestContext,
  options: {
    pair?: boolean
    offer?: Record<string, unknown>
    hello?: () => Promise<typeof HELLO>
    dispatch?: (method: string) => Promise<unknown>
  } = {}
): Promise<{
  socket: Socket
  phone: NoiseTransport
  reply: Buffer
  push: (value: unknown) => void
  attachOptions: () => { batch?: boolean } | undefined
  request: (method: string, id?: number) => void
  decode: (frame: Buffer) => unknown
}> {
  const socket = new Socket()
  const keyPair = generateKeyPair()
  const token = Buffer.alloc(32, 7)
  let push: (value: unknown) => void = () => {
    throw new Error('not attached')
  }
  let attachOptions: { batch?: boolean } | undefined
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
      completePairing: async () => ({ record: pairing, mailboxSecret: Buffer.alloc(32, 9) }),
      touch: async () => {}
    },
    facade: {
      hello: options.hello ?? (async () => HELLO),
      dispatch: async (_context: unknown, method: string) =>
        options.dispatch ? options.dispatch(method) : {}
    },
    hub: () => ({
      attach: (listener: typeof push, attach?: { batch?: boolean }) => {
        push = listener
        attachOptions = attach
        return {
          close: () => {},
          // Mirrors the hub: delivery starts only after the subscribe response is out.
          startDelivery: () => listener({ type: 'event', delivered: true })
        }
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
  const payload = Buffer.from(
    JSON.stringify(
      options.offer ?? { deviceName: 'phone', app: 'test', version: '1', compression: ['gzip'] }
    )
  )
  socket.emit(
    'message',
    Buffer.concat([Buffer.from([options.pair ? 2 : 1]), handshake.writeMessage(payload)]),
    true
  )
  await socket.sent(1)
  const reply = handshake.readMessage(socket.frames[0]!)
  const phone = new NoiseTransport(handshake.split())
  const inflate = createStreamInflateDecoder()
  return {
    socket,
    phone,
    reply,
    push: (value) => push(value),
    attachOptions: () => attachOptions,
    request: (method, id = 1) =>
      socket.emit(
        'message',
        phone.encrypt(Buffer.from(JSON.stringify({ kind: 'rpc:request', id, method, args: [{}] }))),
        true
      ),
    decode: (frame) => JSON.parse(inflate(phone.decrypt(frame)).toString('utf8'))
  }
}

const OFFER = {
  deviceName: 'phone',
  app: 'test',
  version: '1',
  compression: ['gzip'],
  features: ['handshake-hello', 'event-batch', 'stream-deflate', 'future-feature']
}

test('a phone that offers no features gets exactly the original message-2 payload', async (t) => {
  const withGzip = await connect(t)
  assert.equal(withGzip.reply.toString('utf8'), '{"compression":"gzip"}')
  const plain = await connect(t, { offer: { deviceName: 'phone', app: 'test', version: '1' } })
  assert.equal(plain.reply.length, 0)
  const paired = await connect(t, { pair: true })
  assert.equal(paired.reply.toString('utf8'), '{"compression":"gzip"}')
  assert.deepEqual(withGzip.attachOptions(), { batch: false })
})

for (const pair of [false, true]) {
  test(`offered features are answered with a typed reply and hello (${pair ? 'pair' : 'connect'})`, async (t) => {
    const { reply, attachOptions } = await connect(t, { pair, offer: OFFER })
    assert.deepEqual(JSON.parse(reply.toString('utf8')), {
      compression: 'gzip',
      features: ['handshake-hello', 'event-batch', 'stream-deflate'],
      hello: HELLO
    })
    if (!pair) assert.deepEqual(attachOptions(), { batch: true })
  })
}

test('an empty feature offer is answered with an empty list and no hello', async (t) => {
  const { reply } = await connect(t, { offer: { ...OFFER, features: [] } })
  assert.deepEqual(JSON.parse(reply.toString('utf8')), { compression: 'gzip', features: [] })
})

test('handshake-hello is withheld when the hello cannot be built', async (t) => {
  const { reply } = await connect(t, {
    offer: { ...OFFER, compression: undefined },
    hello: async () => {
      throw new Error('runtime unavailable')
    }
  })
  assert.deepEqual(JSON.parse(reply.toString('utf8')), {
    features: ['event-batch', 'stream-deflate']
  })
})

test('stream-deflate sends every message as one sync-flushed deflate stream', async (t) => {
  const { socket, phone, push } = await connect(t, { offer: OFFER })
  const sent = [
    { type: 'event', text: 'streamed '.repeat(40) },
    { type: 'event', text: 'streamed '.repeat(40) },
    { type: 'event', text: '世界 🌸' }
  ]
  for (const payload of sent) push(payload)
  await socket.sent(4)
  const envelopes = socket.frames.slice(1).map((frame) => phone.decrypt(frame))
  assert.ok(envelopes.every((envelope) => envelope[0] === REMOTE_STREAM_DEFLATE_MESSAGE_TAG))
  assert.ok(envelopes[1]!.length < envelopes[0]!.length / 4, 'the shared window pays off')

  // One inflate context across all messages, as the phone keeps it.
  const inflater = createInflateRaw()
  const output: Buffer[] = []
  inflater.on('data', (chunk: Buffer) => output.push(chunk))
  for (const envelope of envelopes) {
    inflater.write(envelope.subarray(1))
    await new Promise<void>((resolve) => inflater.flush(constants.Z_SYNC_FLUSH, () => resolve()))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    Buffer.concat(output).toString('utf8'),
    sent.map((payload) => JSON.stringify({ kind: 'rpc:event', payload })).join('')
  )
  inflater.close()
})

test('the pairing grant stays raw and outside the deflate window', async (t) => {
  const { socket, phone, decode, request } = await connect(t, { pair: true, offer: OFFER })
  request('remote.hello')
  await socket.sent(3)
  const grant = phone.decrypt(socket.frames[1]!)
  assert.equal(grant[0], 0x7b)
  assert.equal(JSON.parse(grant.toString('utf8')).payload.type, 'pairing.granted')
  // The first deflated message starts a fresh stream that never saw the secret.
  const response = decode(socket.frames[2]!) as { kind: string; id: number }
  assert.deepEqual([response.kind, response.id], ['rpc:response', 1])
})

test('an oversized response fails only that call', async (t) => {
  const { socket, decode, request } = await connect(t, {
    offer: OFFER,
    dispatch: async (method) =>
      method === 'big' ? { data: 'x'.repeat(REMOTE_MAX_MESSAGE_BYTES) } : { ok: true }
  })
  request('big', 1)
  request('small', 2)
  await socket.sent(3)
  const [big, small] = socket.frames.slice(1).map(decode) as Array<{
    id: number
    ok: boolean
    error?: { name: string }
  }>
  assert.deepEqual([big!.id, big!.ok, big!.error?.name], [1, false, 'RemoteLimitExceeded'])
  assert.deepEqual([small!.id, small!.ok], [2, true])
  assert.equal(socket.closeCode, undefined)
})

test('delivery starts only after the events.subscribe response is queued', async (t) => {
  const { socket, decode, request } = await connect(t, {
    offer: OFFER,
    dispatch: async () => ({ epoch: 'epoch-1', headSeq: 0, resumed: true })
  })
  request('events.subscribe', 7)
  await socket.sent(3)
  const [response, event] = socket.frames.slice(1).map(decode) as Array<{
    kind: string
    payload?: { delivered?: boolean }
  }>
  assert.equal(response!.kind, 'rpc:response')
  assert.equal(event!.kind, 'rpc:event')
  assert.equal(event!.payload?.delivered, true)
})

test('the stream-deflate encoder enforces the plaintext cap before compressing', async () => {
  const encoder = createStreamDeflateEncoder()
  await assert.rejects(
    encoder.encode(Buffer.concat([Buffer.from('{'), Buffer.alloc(REMOTE_MAX_MESSAGE_BYTES)])),
    /size limit/
  )
  const encoded = await encoder.encode(Buffer.from('{"ok":true}'))
  assert.equal(encoded[0], REMOTE_STREAM_DEFLATE_MESSAGE_TAG)
  encoder.close()
})

test('the committed stream-deflate fixture decodes with one node inflateRaw context', async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../packages/shared/src/remote/fixtures/remote-stream-deflate.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as { raw: string[]; encodedBase64: string[] }
  const decode = createStreamInflateDecoder()
  assert.deepEqual(
    fixture.encodedBase64.map((segment) => decode(Buffer.from(segment, 'base64')).toString('utf8')),
    fixture.raw
  )
  // And the desktop encoder produces the committed bytes for the same messages.
  const encoder = createStreamDeflateEncoder()
  const produced: string[] = []
  for (const raw of fixture.raw) {
    produced.push((await encoder.encode(Buffer.from(raw, 'utf8'))).toString('base64'))
  }
  encoder.close()
  assert.deepEqual(produced, fixture.encodedBase64)
})
