import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PairingStore, plaintextSecretBox } from './pairingStore.ts'
import { RelayAccess } from './relayAccess.ts'

test('orphaned bootstrap grants are deleted after a crash before restoring paired phone keys', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-grants-'))
  try {
    const store = new PairingStore({ directory, secretBox: plaintextSecretBox })
    const requests: string[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push(`${init?.method} ${String(url)}`)
      return new Response(null, { status: 204 })
    }
    const credential = { server: 'https://relay.example', hostId: 'mac-1', key: 'K'.repeat(43) }
    const access = new RelayAccess(credential, store, fetchImpl)
    const bootstrap = await access.bootstrap()
    const pending = new PairingStore({ directory, secretBox: plaintextSecretBox })
    await new RelayAccess(credential, pending, fetchImpl).restore()
    const phone = new URL(bootstrap.url).pathname.split('/')[4]
    assert.equal(requests.at(-1), `DELETE https://relay.example/v1/hosts/mac-1/phones/${phone}`)
    assert.deepEqual(await pending.relayGrantIds(), [])
    assert.equal((await store.relayGrantIds()).length, 1, 'the old process snapshot is not reused')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('re-pairing the same Noise key replaces the old pairing ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-repair-'))
  try {
    const store = new PairingStore({ directory, secretBox: plaintextSecretBox })
    const phoneKey = randomBytes(32)
    const first = await store.completePairing({
      token: store.createOffer().token,
      phoneKey,
      deviceName: 'iPhone'
    })
    const second = await store.completePairing({
      token: store.createOffer().token,
      phoneKey,
      deviceName: 'iPhone'
    })
    assert.deepEqual(second.replacedPairingIds, [first.record.pairingId])
    assert.equal((await store.list()).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('host reconnect restores the still-current QR bootstrap instead of deleting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-qr-restore-'))
  try {
    const store = new PairingStore({ directory, secretBox: plaintextSecretBox })
    const requests: string[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push(`${init?.method} ${String(url)}`)
      return new Response(null, { status: 204 })
    }
    const access = new RelayAccess(
      { server: 'https://relay.example', hostId: 'mac-1', key: 'K'.repeat(43) },
      store,
      fetchImpl
    )
    const bootstrap = await access.bootstrap()
    await access.restore(bootstrap)
    assert.equal(requests.length, 2)
    assert.equal(requests[1]?.startsWith('PUT '), true)
    assert.equal((await store.relayGrantIds()).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
