import { REMOTE_NOISE_PROLOGUE } from '@yachiyo/shared/remote/wire'

import { HandshakeState, type NoisePattern } from './handshake.ts'
import { deriveMailboxKeys, sealMailbox } from './mailboxCrypto.ts'
import { keyPairFromPrivate } from './primitives.ts'
import { NoiseTransport } from './transport.ts'

// Deterministic inputs shared with the Swift client tests. Changing them rewrites the fixtures.
const hex = (value: string): Buffer => Buffer.from(value, 'hex')
const DESKTOP_STATIC = hex('a8abababababababababababababababababababababababababababababab6b')
const PHONE_STATIC = hex('b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecf')
const PHONE_EPHEMERAL = hex('d0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef')
const DESKTOP_EPHEMERAL = hex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff000102030405060708090a0b0c0d0e0f')
const PAIRING_TOKEN = hex('5a'.repeat(32))
const MAILBOX_SECRET = hex('0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0')
const MAILBOX_NONCE = hex('000102030405060708090a0b')

interface NoiseSessionFixture {
  pattern: NoisePattern
  prologue: string
  desktopStaticPrivate: string
  desktopStaticPublic: string
  phoneStaticPrivate: string
  phoneStaticPublic: string
  phoneEphemeralPrivate: string
  desktopEphemeralPrivate: string
  psk?: string
  message1Payload: string
  message1: string
  message2Payload: string
  message2: string
  handshakeHash: string
  /** Transport frames in order; `from` names the sender. */
  transport: Array<{ from: 'phone' | 'desktop'; plaintext: string; ciphertext: string }>
}

function buildSession(pattern: NoisePattern): NoiseSessionFixture {
  const desktop = keyPairFromPrivate(DESKTOP_STATIC)
  const phone = keyPairFromPrivate(PHONE_STATIC)
  const prologue = Buffer.from(REMOTE_NOISE_PROLOGUE, 'utf8')
  const psk = pattern === 'IKpsk2' ? PAIRING_TOKEN : undefined

  const initiator = HandshakeState.initiator({
    pattern,
    prologue,
    staticKeyPair: phone,
    remoteStaticKey: desktop.publicKey,
    ephemeralKeyPair: keyPairFromPrivate(PHONE_EPHEMERAL),
    psk
  })
  const responder = HandshakeState.responder({
    pattern,
    prologue,
    staticKeyPair: desktop,
    ephemeralKeyPair: keyPairFromPrivate(DESKTOP_EPHEMERAL),
    psk
  })

  const message1Payload = Buffer.from(
    JSON.stringify({ deviceName: 'Test iPhone', app: 'yachiyo-ios', version: '1.0.0' }),
    'utf8'
  )
  const message1 = initiator.writeMessage(message1Payload)
  responder.readMessage(message1)
  const message2Payload = Buffer.alloc(0)
  const message2 = responder.writeMessage(message2Payload)
  initiator.readMessage(message2)

  const phoneTransport = new NoiseTransport(initiator.split())
  const desktopTransport = new NoiseTransport(responder.split())
  const frames: Array<{ from: 'phone' | 'desktop'; text: string }> = [
    { from: 'phone', text: '{"kind":"rpc:request","id":1,"method":"remote.hello","args":[]}' },
    { from: 'desktop', text: '{"kind":"rpc:response","id":1,"ok":true,"value":{}}' },
    { from: 'desktop', text: 'x'.repeat(70_000) },
    { from: 'phone', text: '' }
  ]
  const transport = frames.map(({ from, text }) => {
    const plaintext = Buffer.from(text, 'utf8')
    const ciphertext = (from === 'phone' ? phoneTransport : desktopTransport).encrypt(plaintext)
    ;(from === 'phone' ? desktopTransport : phoneTransport).decrypt(ciphertext)
    return { from, plaintext: plaintext.toString('hex'), ciphertext: ciphertext.toString('hex') }
  })

  return {
    pattern,
    prologue: prologue.toString('hex'),
    desktopStaticPrivate: DESKTOP_STATIC.toString('hex'),
    desktopStaticPublic: desktop.publicKey.toString('hex'),
    phoneStaticPrivate: PHONE_STATIC.toString('hex'),
    phoneStaticPublic: phone.publicKey.toString('hex'),
    phoneEphemeralPrivate: PHONE_EPHEMERAL.toString('hex'),
    desktopEphemeralPrivate: DESKTOP_EPHEMERAL.toString('hex'),
    ...(psk ? { psk: psk.toString('hex') } : {}),
    message1Payload: message1Payload.toString('hex'),
    message1: message1.toString('hex'),
    message2Payload: message2Payload.toString('hex'),
    message2: message2.toString('hex'),
    handshakeHash: initiator.handshakeHash.toString('hex'),
    transport
  }
}

export function buildNoiseSessionFixtures(): NoiseSessionFixture[] {
  return [buildSession('IK'), buildSession('IKpsk2')]
}

export function buildMailboxFixture(): Record<string, unknown> {
  const { mailboxId, mailboxKey } = deriveMailboxKeys(MAILBOX_SECRET)
  const plaintext = {
    remoteDeviceId: '0123456789abcdef0123456789abcdef',
    endpoints: [{ kind: 'tunnel' as const, url: 'wss://quiet-fox.trycloudflare.com/remote/v1' }],
    counter: 5,
    issuedAt: '2026-09-22T12:00:00.000Z'
  }
  return {
    mailboxSecret: MAILBOX_SECRET.toString('hex'),
    mailboxId,
    mailboxKey: mailboxKey.toString('hex'),
    nonce: MAILBOX_NONCE.toString('hex'),
    plaintext,
    box: sealMailbox(mailboxKey, plaintext, MAILBOX_NONCE).toString('hex'),
    /** A reader whose last seen counter is at least this value must reject the box. */
    rejectWhenLastCounterAtLeast: plaintext.counter
  }
}
