import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject
} from 'node:crypto'

export const DH_LEN = 32
export const HASH_LEN = 32
export const TAG_LEN = 16
export const KEY_LEN = 32

// DER prefixes for raw X25519 keys (RFC 8410).
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

export interface KeyPair {
  publicKey: Buffer
  privateKey: Buffer
}

function privateKeyObject(privateKey: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, privateKey]),
    format: 'der',
    type: 'pkcs8'
  })
}

function publicKeyObject(publicKey: Buffer): KeyObject {
  if (publicKey.length !== DH_LEN) throw new Error('Invalid X25519 public key length.')
  return createPublicKey({
    key: Buffer.concat([SPKI_X25519_PREFIX, publicKey]),
    format: 'der',
    type: 'spki'
  })
}

export function keyPairFromPrivate(privateKey: Buffer): KeyPair {
  if (privateKey.length !== DH_LEN) throw new Error('Invalid X25519 private key length.')
  const publicDer = createPublicKey(privateKeyObject(privateKey)).export({
    format: 'der',
    type: 'spki'
  })
  return {
    privateKey: Buffer.from(privateKey),
    publicKey: publicDer.subarray(SPKI_X25519_PREFIX.length)
  }
}

export function generateKeyPair(): KeyPair {
  const { privateKey } = generateKeyPairSync('x25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' })
  return keyPairFromPrivate(der.subarray(PKCS8_X25519_PREFIX.length))
}

export function dh(keyPair: KeyPair, publicKey: Buffer): Buffer {
  return diffieHellman({
    privateKey: privateKeyObject(keyPair.privateKey),
    publicKey: publicKeyObject(publicKey)
  })
}

// ChaCha20-Poly1305 comes from @noble/ciphers: Electron's BoringSSL-backed node:crypto has no
// 'chacha20-poly1305' cipher, so createCipheriv would throw "Unknown cipher" in the app.

/** Noise ChaChaPoly nonce: 32 zero bits followed by the little-endian 64-bit counter. */
function noiseNonce(counter: bigint): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeBigUInt64LE(counter, 4)
  return nonce
}

export function aeadEncrypt(
  key: Buffer,
  nonce: Buffer | bigint,
  ad: Buffer,
  plaintext: Buffer
): Buffer {
  const iv = typeof nonce === 'bigint' ? noiseNonce(nonce) : nonce
  return Buffer.from(chacha20poly1305(key, iv, ad).encrypt(plaintext))
}

export function aeadDecrypt(
  key: Buffer,
  nonce: Buffer | bigint,
  ad: Buffer,
  ciphertext: Buffer
): Buffer {
  if (ciphertext.length < TAG_LEN) throw new Error('Ciphertext is shorter than the auth tag.')
  const iv = typeof nonce === 'bigint' ? noiseNonce(nonce) : nonce
  return Buffer.from(chacha20poly1305(key, iv, ad).decrypt(ciphertext))
}

export function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

function hmac(key: Buffer, ...parts: Buffer[]): Buffer {
  const mac = createHmac('sha256', key)
  for (const part of parts) mac.update(part)
  return mac.digest()
}

/** Noise HKDF (spec §4.3), which differs from RFC 5869 in how it chains outputs. */
export function noiseHkdf(chainingKey: Buffer, ikm: Buffer, outputs: 2 | 3): Buffer[] {
  const tempKey = hmac(chainingKey, ikm)
  const out1 = hmac(tempKey, Buffer.from([1]))
  const out2 = hmac(tempKey, out1, Buffer.from([2]))
  if (outputs === 2) return [out1, out2]
  return [out1, out2, hmac(tempKey, out2, Buffer.from([3]))]
}
