import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { generateKeyPair } from './noise/primitives.ts'
import { PAIRING_TOKEN_TTL_MS, PairingStore, type SecretBox } from './pairingStore.ts'

// Reversible stand-in for safeStorage that makes wrapped bytes visibly different.
const xorBox: SecretBox = {
  encrypt: (plaintext) => Buffer.from(plaintext.map((byte) => byte ^ 0x5a)),
  decrypt: (ciphertext) => Buffer.from(ciphertext.map((byte) => byte ^ 0x5a))
}

async function withDirectory(fn: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-pairing-store-'))
  try {
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('the desktop identity is generated once and reloaded through the secret box', async () => {
  await withDirectory(async (directory) => {
    const first = await new PairingStore({ directory, secretBox: xorBox }).loadIdentity()
    const second = await new PairingStore({ directory, secretBox: xorBox }).loadIdentity()

    assert.deepEqual(second.keyPair.publicKey, first.keyPair.publicKey)
    assert.equal(second.remoteDeviceId, first.remoteDeviceId)
    assert.match(first.remoteDeviceId, /^[0-9a-f]{32}$/)
  })
})

test('pairing tokens expire, are single-use, and are replaced by a newer offer', async () => {
  await withDirectory(async (directory) => {
    let now = 1_000
    const store = new PairingStore({ directory, secretBox: xorBox, now: () => now })
    const phoneKey = generateKeyPair().publicKey

    const stale = store.createOffer()
    const fresh = store.createOffer()
    await assert.rejects(store.completePairing({ token: stale.token, phoneKey, deviceName: 'a' }))

    now += PAIRING_TOKEN_TTL_MS
    assert.equal(store.activeToken(), null)
    await assert.rejects(store.completePairing({ token: fresh.token, phoneKey, deviceName: 'a' }))

    const offer = store.createOffer()
    const { record, mailboxSecret } = await store.completePairing({
      token: offer.token,
      phoneKey,
      deviceName: 'iPhone'
    })
    assert.equal(store.activeToken(), null)
    assert.deepEqual(await store.mailboxSecret(record.pairingId), mailboxSecret)
    assert.deepEqual(await store.findByPhoneKey(phoneKey), record)
  })
})

test('mailbox counters and pairings persist across store instances', async () => {
  await withDirectory(async (directory) => {
    const store = new PairingStore({ directory, secretBox: xorBox })
    const offer = store.createOffer()
    const { record } = await store.completePairing({
      token: offer.token,
      phoneKey: generateKeyPair().publicKey,
      deviceName: 'iPhone'
    })
    assert.equal(await store.nextMailboxCounter(record.pairingId), 1)
    assert.equal(await store.nextMailboxCounter(record.pairingId), 2)

    const reloaded = new PairingStore({ directory, secretBox: xorBox })
    assert.equal((await reloaded.list())[0]?.mailboxCounter, 2)
    assert.equal(await reloaded.revoke(record.pairingId), true)
    assert.deepEqual(await reloaded.list(), [])
  })
})
