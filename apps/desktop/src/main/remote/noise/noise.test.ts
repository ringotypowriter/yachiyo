import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildMailboxFixture, buildNoiseSessionFixtures } from './crossLanguageFixtures.ts'
import { HandshakeState, type NoisePattern } from './handshake.ts'
import { deriveMailboxKeys, openMailbox, sealMailbox } from './mailboxCrypto.ts'
import { generateKeyPair, keyPairFromPrivate } from './primitives.ts'
import { NoiseTransport } from './transport.ts'

interface CacophonyVector {
  protocol_name: string
  init_prologue: string
  init_psks?: string[]
  init_static: string
  init_ephemeral: string
  init_remote_static: string
  resp_prologue: string
  resp_psks?: string[]
  resp_static: string
  resp_ephemeral: string
  handshake_hash: string
  messages: Array<{ payload: string; ciphertext: string }>
}

const fixturesUrl = new URL(
  '../../../../../../packages/shared/src/remote/fixtures/',
  import.meta.url
)
const hex = (value: string): Buffer => Buffer.from(value, 'hex')

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, fixturesUrl), 'utf8')) as T
}

const vectors = readFixture<{ vectors: CacophonyVector[] }>('noise-cacophony-vectors.json').vectors

for (const vector of vectors) {
  test(`${vector.protocol_name} matches the cacophony test vector`, () => {
    const pattern = vector.protocol_name.split('_')[1] as NoisePattern
    const initiator = HandshakeState.initiator({
      pattern,
      prologue: hex(vector.init_prologue),
      staticKeyPair: keyPairFromPrivate(hex(vector.init_static)),
      ephemeralKeyPair: keyPairFromPrivate(hex(vector.init_ephemeral)),
      remoteStaticKey: hex(vector.init_remote_static),
      psk: vector.init_psks?.[0] ? hex(vector.init_psks[0]) : undefined
    })
    const responder = HandshakeState.responder({
      pattern,
      prologue: hex(vector.resp_prologue),
      staticKeyPair: keyPairFromPrivate(hex(vector.resp_static)),
      ephemeralKeyPair: keyPairFromPrivate(hex(vector.resp_ephemeral)),
      psk: vector.resp_psks?.[0] ? hex(vector.resp_psks[0]) : undefined
    })

    const [first, second, ...transportMessages] = vector.messages
    const message1 = initiator.writeMessage(hex(first.payload))
    assert.equal(message1.toString('hex'), first.ciphertext)
    assert.equal(responder.readMessage(message1).toString('hex'), first.payload)
    assert.deepEqual(
      responder.remoteStaticKey,
      keyPairFromPrivate(hex(vector.init_static)).publicKey
    )

    const message2 = responder.writeMessage(hex(second.payload))
    assert.equal(message2.toString('hex'), second.ciphertext)
    assert.equal(initiator.readMessage(message2).toString('hex'), second.payload)

    assert.equal(initiator.handshakeHash.toString('hex'), vector.handshake_hash)
    assert.equal(responder.handshakeHash.toString('hex'), vector.handshake_hash)

    const initiatorTransport = new NoiseTransport(initiator.split())
    const responderTransport = new NoiseTransport(responder.split())
    transportMessages.forEach((message, index) => {
      const [sender, receiver] =
        index % 2 === 0
          ? [initiatorTransport, responderTransport]
          : [responderTransport, initiatorTransport]
      const ciphertext = sender.encrypt(hex(message.payload))
      assert.equal(ciphertext.toString('hex'), message.ciphertext)
      assert.equal(receiver.decrypt(ciphertext).toString('hex'), message.payload)
    })
  })
}

function connectedPair(pattern: NoisePattern = 'IK'): {
  phone: NoiseTransport
  desktop: NoiseTransport
} {
  const desktopKeys = generateKeyPair()
  const psk = pattern === 'IKpsk2' ? Buffer.alloc(32, 7) : undefined
  const prologue = Buffer.from('test')
  const initiator = HandshakeState.initiator({
    pattern,
    prologue,
    staticKeyPair: generateKeyPair(),
    remoteStaticKey: desktopKeys.publicKey,
    psk
  })
  const responder = HandshakeState.responder({ pattern, prologue, staticKeyPair: desktopKeys, psk })
  responder.readMessage(initiator.writeMessage(Buffer.alloc(0)))
  initiator.readMessage(responder.writeMessage(Buffer.alloc(0)))
  return {
    phone: new NoiseTransport(initiator.split()),
    desktop: new NoiseTransport(responder.split())
  }
}

test('transport rejects a tampered frame and then refuses all further traffic', () => {
  const { phone, desktop } = connectedPair()
  const frame = phone.encrypt(Buffer.from('hello'))
  frame[frame.length - 1] ^= 0x01

  assert.throws(() => desktop.decrypt(frame))
  assert.equal(desktop.isFailed, true)
  assert.throws(() => desktop.decrypt(phone.encrypt(Buffer.from('next'))), /closed/)
})

test('transport rejects replayed and reordered frames', () => {
  const { phone, desktop } = connectedPair()
  const first = phone.encrypt(Buffer.from('one'))
  const second = phone.encrypt(Buffer.from('two'))

  assert.equal(desktop.decrypt(first).toString(), 'one')
  assert.throws(() => desktop.decrypt(first), 'replayed frame reuses an old nonce')

  const reordered = connectedPair()
  const a = reordered.phone.encrypt(Buffer.from('a'))
  const b = reordered.phone.encrypt(Buffer.from('b'))
  assert.throws(() => reordered.desktop.decrypt(b), 'frame ahead of the counter')
  assert.throws(() => reordered.desktop.decrypt(a), 'channel stays closed after a failure')
  assert.ok(second.length > 0)
})

test('transport accepts messages above the Noise 65535-byte limit up to 8 MB', () => {
  const { phone, desktop } = connectedPair()
  const large = Buffer.alloc(1024 * 1024, 0x61)

  assert.deepEqual(desktop.decrypt(phone.encrypt(large)), large)
  assert.throws(() => phone.encrypt(Buffer.alloc(8 * 1024 * 1024 + 1)), /size limit/)
})

test('pairing handshake fails for a phone that holds the wrong token', () => {
  const desktopKeys = generateKeyPair()
  const prologue = Buffer.from('test')
  const initiator = HandshakeState.initiator({
    pattern: 'IKpsk2',
    prologue,
    staticKeyPair: generateKeyPair(),
    remoteStaticKey: desktopKeys.publicKey,
    psk: Buffer.alloc(32, 1)
  })
  const responder = HandshakeState.responder({
    pattern: 'IKpsk2',
    prologue,
    staticKeyPair: desktopKeys
  })

  responder.readMessage(initiator.writeMessage(Buffer.alloc(0)))
  responder.setPsk(Buffer.alloc(32, 2))
  assert.throws(() => initiator.readMessage(responder.writeMessage(Buffer.alloc(0))))
})

test('IK handshake fails when the phone expects a different desktop key', () => {
  const prologue = Buffer.from('test')
  const initiator = HandshakeState.initiator({
    pattern: 'IK',
    prologue,
    staticKeyPair: generateKeyPair(),
    remoteStaticKey: generateKeyPair().publicKey
  })
  const responder = HandshakeState.responder({
    pattern: 'IK',
    prologue,
    staticKeyPair: generateKeyPair()
  })

  assert.throws(() => responder.readMessage(initiator.writeMessage(Buffer.alloc(0))))
})

test('mailbox opens only for the right key and a newer counter', () => {
  const secret = Buffer.alloc(32, 9)
  const { mailboxId, mailboxKey } = deriveMailboxKeys(secret)
  const plaintext = {
    remoteDeviceId: '0123456789abcdef0123456789abcdef',
    endpoints: [{ kind: 'tunnel' as const, url: 'wss://a.trycloudflare.com/remote/v1' }],
    counter: 3,
    issuedAt: '2026-09-22T12:00:00.000Z'
  }
  const box = sealMailbox(mailboxKey, plaintext)

  assert.match(mailboxId, /^[0-9a-f]{32}$/)
  assert.deepEqual(openMailbox(mailboxKey, box, 2), plaintext)
  assert.throws(() => openMailbox(mailboxKey, box, 3), /rolled back/)
  assert.throws(() => openMailbox(mailboxKey, box, 10), /rolled back/)
  assert.throws(() => openMailbox(deriveMailboxKeys(Buffer.alloc(32, 8)).mailboxKey, box, 0))

  const tampered = Buffer.from(box)
  tampered[20] ^= 0xff
  assert.throws(() => openMailbox(mailboxKey, tampered, 0))
})

test('cross-language fixtures are current', () => {
  assert.deepEqual(readFixture('noise-sessions.json'), buildNoiseSessionFixtures())
  assert.deepEqual(readFixture('mailbox.json'), buildMailboxFixture())
})
