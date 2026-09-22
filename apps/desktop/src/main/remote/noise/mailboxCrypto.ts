import { hkdfSync, randomBytes } from 'node:crypto'

import { mailboxPlaintextSchema, type MailboxPlaintext } from '@yachiyo/shared/remote/mailbox'

import { aeadDecrypt, aeadEncrypt } from './primitives.ts'

const MAILBOX_VERSION = 0x01
const NONCE_LEN = 12
const ID_INFO = 'yachiyo-remote/v1/mailbox-id'
const KEY_INFO = 'yachiyo-remote/v1/mailbox-key'

export interface MailboxKeys {
  mailboxId: string
  mailboxKey: Buffer
}

function hkdf(secret: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(info, 'utf8'), length))
}

/** RFC 5869 HKDF-SHA256 with an empty salt; the phone derives the same file name and key. */
export function deriveMailboxKeys(mailboxSecret: Buffer): MailboxKeys {
  if (mailboxSecret.length !== 32) throw new Error('Mailbox secret must be 32 bytes.')
  return {
    mailboxId: hkdf(mailboxSecret, ID_INFO, 32).subarray(0, 16).toString('hex'),
    mailboxKey: hkdf(mailboxSecret, KEY_INFO, 32)
  }
}

/** `box = 0x01 || nonce(12) || ChaCha20-Poly1305(key, nonce, ad = 0x01, JSON plaintext)`. */
export function sealMailbox(
  mailboxKey: Buffer,
  plaintext: MailboxPlaintext,
  nonce: Buffer = randomBytes(NONCE_LEN)
): Buffer {
  const header = Buffer.from([MAILBOX_VERSION])
  const body = Buffer.from(JSON.stringify(mailboxPlaintextSchema.parse(plaintext)), 'utf8')
  return Buffer.concat([header, nonce, aeadEncrypt(mailboxKey, nonce, header, body)])
}

/**
 * Opens a mailbox box and rejects anything not newer than `lastCounter`, so a stale iCloud
 * copy or a replayed file cannot move the phone back to an old address.
 */
export function openMailbox(
  mailboxKey: Buffer,
  box: Buffer,
  lastCounter: number
): MailboxPlaintext {
  if (box.length < 1 + NONCE_LEN || box[0] !== MAILBOX_VERSION) {
    throw new Error('Unsupported mailbox format.')
  }
  const header = box.subarray(0, 1)
  const nonce = box.subarray(1, 1 + NONCE_LEN)
  const plaintext = aeadDecrypt(mailboxKey, nonce, header, box.subarray(1 + NONCE_LEN))
  const parsed = mailboxPlaintextSchema.parse(JSON.parse(plaintext.toString('utf8')))
  if (parsed.counter <= lastCounter) {
    throw new Error('Mailbox counter rolled back.')
  }
  return parsed
}
