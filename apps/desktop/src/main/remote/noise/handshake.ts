import {
  aeadDecrypt,
  aeadEncrypt,
  dh,
  DH_LEN,
  generateKeyPair,
  HASH_LEN,
  KEY_LEN,
  noiseHkdf,
  sha256,
  TAG_LEN,
  type KeyPair
} from './primitives.ts'

export type NoisePattern = 'IK' | 'IKpsk2'

const PROTOCOL_NAMES: Record<NoisePattern, string> = {
  IK: 'Noise_IK_25519_ChaChaPoly_SHA256',
  IKpsk2: 'Noise_IKpsk2_25519_ChaChaPoly_SHA256'
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk'

const MESSAGE_PATTERNS: Record<NoisePattern, Token[][]> = {
  IK: [
    ['e', 'es', 's', 'ss'],
    ['e', 'ee', 'se']
  ],
  IKpsk2: [
    ['e', 'es', 's', 'ss'],
    ['e', 'ee', 'se', 'psk']
  ]
}

const MAX_NONCE = 2n ** 64n - 1n

export class CipherState {
  private key: Buffer | null
  private nonce = 0n

  constructor(key: Buffer | null = null) {
    this.key = key
  }

  hasKey(): boolean {
    return this.key !== null
  }

  /** Next nonce; exposed so tests can assert that counters only move forward. */
  get counter(): bigint {
    return this.nonce
  }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.key) return Buffer.from(plaintext)
    if (this.nonce >= MAX_NONCE) throw new Error('Noise nonce exhausted.')
    const ciphertext = aeadEncrypt(this.key, this.nonce, ad, plaintext)
    this.nonce += 1n
    return ciphertext
  }

  decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.key) return Buffer.from(ciphertext)
    if (this.nonce >= MAX_NONCE) throw new Error('Noise nonce exhausted.')
    // The nonce only advances after successful authentication (Noise spec §5.1).
    const plaintext = aeadDecrypt(this.key, this.nonce, ad, ciphertext)
    this.nonce += 1n
    return plaintext
  }
}

class SymmetricState {
  private chainingKey: Buffer
  hash: Buffer
  private cipher = new CipherState()

  constructor(protocolName: string) {
    const name = Buffer.from(protocolName, 'ascii')
    this.hash =
      name.length <= HASH_LEN
        ? Buffer.concat([name, Buffer.alloc(HASH_LEN - name.length)])
        : sha256(name)
    this.chainingKey = Buffer.from(this.hash)
  }

  hasKey(): boolean {
    return this.cipher.hasKey()
  }

  mixKey(ikm: Buffer): void {
    const [chainingKey, tempKey] = noiseHkdf(this.chainingKey, ikm, 2)
    this.chainingKey = chainingKey
    this.cipher = new CipherState(tempKey.subarray(0, KEY_LEN))
  }

  mixHash(data: Buffer): void {
    this.hash = sha256(this.hash, data)
  }

  mixKeyAndHash(ikm: Buffer): void {
    const [chainingKey, tempHash, tempKey] = noiseHkdf(this.chainingKey, ikm, 3)
    this.chainingKey = chainingKey
    this.mixHash(tempHash)
    this.cipher = new CipherState(tempKey.subarray(0, KEY_LEN))
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [CipherState, CipherState] {
    const [key1, key2] = noiseHkdf(this.chainingKey, Buffer.alloc(0), 2)
    return [new CipherState(key1.subarray(0, KEY_LEN)), new CipherState(key2.subarray(0, KEY_LEN))]
  }
}

export interface HandshakeOptions {
  pattern: NoisePattern
  prologue: Buffer
  staticKeyPair: KeyPair
  /** Initiator only: the responder's static public key, known in advance (IK pre-message). */
  remoteStaticKey?: Buffer
  psk?: Buffer
  /** Fixed ephemeral key for test vectors; generated when omitted. */
  ephemeralKeyPair?: KeyPair
}

export interface TransportCiphers {
  send: CipherState
  receive: CipherState
  handshakeHash: Buffer
}

export class HandshakeState {
  private readonly symmetric: SymmetricState
  private readonly patterns: Token[][]
  private readonly initiator: boolean
  private readonly s: KeyPair
  private e: KeyPair | null
  private rs: Buffer | null
  private re: Buffer | null = null
  private psk: Buffer | null
  private messageIndex = 0
  private readonly pattern: NoisePattern

  private constructor(initiator: boolean, options: HandshakeOptions) {
    this.initiator = initiator
    this.pattern = options.pattern
    this.patterns = MESSAGE_PATTERNS[options.pattern]
    this.symmetric = new SymmetricState(PROTOCOL_NAMES[options.pattern])
    this.s = options.staticKeyPair
    this.e = options.ephemeralKeyPair ?? null
    this.rs = options.remoteStaticKey ?? null
    this.psk = options.psk ?? null
    if (this.psk && this.psk.length !== 32) throw new Error('Noise PSK must be 32 bytes.')

    this.symmetric.mixHash(options.prologue)
    // IK pre-message pattern: <- s
    const responderStatic = initiator ? this.rs : this.s.publicKey
    if (!responderStatic) throw new Error('IK initiator requires the responder static key.')
    this.symmetric.mixHash(responderStatic)
  }

  static initiator(options: HandshakeOptions): HandshakeState {
    return new HandshakeState(true, options)
  }

  static responder(options: Omit<HandshakeOptions, 'remoteStaticKey'>): HandshakeState {
    return new HandshakeState(false, options)
  }

  get isComplete(): boolean {
    return this.messageIndex >= this.patterns.length
  }

  get remoteStaticKey(): Buffer | null {
    return this.rs
  }

  get handshakeHash(): Buffer {
    return Buffer.from(this.symmetric.hash)
  }

  /** Responder side of a pairing handshake: the PSK may be chosen after reading message 1. */
  setPsk(psk: Buffer): void {
    if (this.pattern !== 'IKpsk2') throw new Error('PSK is only used by IKpsk2.')
    if (psk.length !== 32) throw new Error('Noise PSK must be 32 bytes.')
    this.psk = psk
  }

  writeMessage(payload: Buffer): Buffer {
    const tokens = this.nextTokens(true)
    const parts: Buffer[] = []
    for (const token of tokens) {
      switch (token) {
        case 'e': {
          this.e ??= generateKeyPair()
          parts.push(this.e.publicKey)
          this.symmetric.mixHash(this.e.publicKey)
          // psk handshakes also mix the ephemeral into the key (Noise spec §9.2).
          if (this.pattern === 'IKpsk2') this.symmetric.mixKey(this.e.publicKey)
          break
        }
        case 's':
          parts.push(this.symmetric.encryptAndHash(this.s.publicKey))
          break
        case 'psk':
          this.symmetric.mixKeyAndHash(this.requirePsk())
          break
        default:
          this.symmetric.mixKey(this.dhToken(token))
      }
    }
    parts.push(this.symmetric.encryptAndHash(payload))
    this.messageIndex += 1
    return Buffer.concat(parts)
  }

  readMessage(message: Buffer): Buffer {
    const tokens = this.nextTokens(false)
    let offset = 0
    const take = (length: number): Buffer => {
      if (offset + length > message.length) throw new Error('Noise handshake message is too short.')
      const slice = message.subarray(offset, offset + length)
      offset += length
      return slice
    }
    for (const token of tokens) {
      switch (token) {
        case 'e': {
          this.re = Buffer.from(take(DH_LEN))
          this.symmetric.mixHash(this.re)
          if (this.pattern === 'IKpsk2') this.symmetric.mixKey(this.re)
          break
        }
        case 's': {
          const length = this.symmetric.hasKey() ? DH_LEN + TAG_LEN : DH_LEN
          this.rs = Buffer.from(this.symmetric.decryptAndHash(take(length)))
          break
        }
        case 'psk':
          this.symmetric.mixKeyAndHash(this.requirePsk())
          break
        default:
          this.symmetric.mixKey(this.dhToken(token))
      }
    }
    const payload = this.symmetric.decryptAndHash(message.subarray(offset))
    this.messageIndex += 1
    return payload
  }

  /** Transport ciphers after the final handshake message, oriented for this side. */
  split(): TransportCiphers {
    if (!this.isComplete) throw new Error('Noise handshake is not complete.')
    const [initiatorToResponder, responderToInitiator] = this.symmetric.split()
    return this.initiator
      ? {
          send: initiatorToResponder,
          receive: responderToInitiator,
          handshakeHash: this.handshakeHash
        }
      : {
          send: responderToInitiator,
          receive: initiatorToResponder,
          handshakeHash: this.handshakeHash
        }
  }

  private nextTokens(writing: boolean): Token[] {
    const tokens = this.patterns[this.messageIndex]
    if (!tokens) throw new Error('Noise handshake is already complete.')
    const initiatorTurn = this.messageIndex % 2 === 0
    if (initiatorTurn !== (this.initiator === writing)) {
      throw new Error('Noise handshake message out of order.')
    }
    return tokens
  }

  private requirePsk(): Buffer {
    if (!this.psk) throw new Error('Noise PSK is required for this handshake.')
    return this.psk
  }

  private dhToken(token: Exclude<Token, 'e' | 's' | 'psk'>): Buffer {
    // Token letters name (initiator key, responder key); each side picks its own half.
    const [initiatorKey, responderKey] = token.split('') as ['e' | 's', 'e' | 's']
    const localKind = this.initiator ? initiatorKey : responderKey
    const remoteKind = this.initiator ? responderKey : initiatorKey
    const local = localKind === 'e' ? this.e : this.s
    const remote = remoteKind === 'e' ? this.re : this.rs
    if (!local || !remote) throw new Error(`Noise handshake is missing keys for ${token}.`)
    return dh(local, remote)
  }
}
