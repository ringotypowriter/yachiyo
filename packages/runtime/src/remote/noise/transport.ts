import { REMOTE_MAX_MESSAGE_BYTES } from '@yachiyo/shared/remote/methods'

import type { CipherState, TransportCiphers } from './handshake.ts'
import { TAG_LEN } from './primitives.ts'

const EMPTY_AD = Buffer.alloc(0)

/**
 * Post-handshake encryption, one AEAD message per WebSocket binary frame. Nonces are implicit
 * counters, so any dropped, replayed, reordered, or tampered frame fails authentication; after
 * the first failure the channel refuses all further traffic.
 */
export class NoiseTransport {
  private readonly send: CipherState
  private readonly receive: CipherState
  private failed = false
  readonly handshakeHash: Buffer

  constructor(ciphers: TransportCiphers) {
    this.send = ciphers.send
    this.receive = ciphers.receive
    this.handshakeHash = ciphers.handshakeHash
  }

  encrypt(plaintext: Buffer): Buffer {
    this.assertUsable()
    if (plaintext.length > REMOTE_MAX_MESSAGE_BYTES) {
      throw new Error('Remote message exceeds the size limit.')
    }
    return this.send.encryptWithAd(EMPTY_AD, plaintext)
  }

  decrypt(ciphertext: Buffer): Buffer {
    this.assertUsable()
    if (ciphertext.length > REMOTE_MAX_MESSAGE_BYTES + TAG_LEN) {
      this.failed = true
      throw new Error('Remote message exceeds the size limit.')
    }
    try {
      return this.receive.decryptWithAd(EMPTY_AD, ciphertext)
    } catch (error) {
      this.failed = true
      throw error
    }
  }

  get isFailed(): boolean {
    return this.failed
  }

  private assertUsable(): void {
    if (this.failed) throw new Error('Remote channel is closed after an authentication failure.')
  }
}
