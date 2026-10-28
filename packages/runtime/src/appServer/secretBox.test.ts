import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { createAppServerSecretBox, isAppServerSecret } from './secretBox.ts'

test('server credentials decrypt across restarts and reject wrong keys and tampering', () => {
  const key = randomBytes(32)
  const plaintext = Buffer.from('remote credential fixture')
  const envelope = createAppServerSecretBox(key).encrypt(plaintext)
  assert.equal(isAppServerSecret(envelope), true)
  assert.deepEqual(createAppServerSecretBox(key).decrypt(envelope), plaintext)
  assert.equal(envelope.includes(plaintext), false)
  assert.throws(() => createAppServerSecretBox(randomBytes(32)).decrypt(envelope))
  envelope[envelope.length - 1] ^= 1
  assert.throws(() => createAppServerSecretBox(key).decrypt(envelope))
})

test('only legacy values explicitly unlocked by the shell can be read', () => {
  const legacy = Buffer.from('opaque wallet ciphertext')
  const plaintext = randomBytes(32)
  const key = randomBytes(32)
  const box = createAppServerSecretBox(key, {
    [legacy.toString('base64')]: plaintext.toString('base64')
  })
  assert.deepEqual(box.decrypt(legacy), plaintext)
  assert.deepEqual(createAppServerSecretBox(key).decrypt(box.encrypt(plaintext)), plaintext)
  assert.throws(() => createAppServerSecretBox(key).decrypt(legacy), /unlocked by the desktop/)
})
