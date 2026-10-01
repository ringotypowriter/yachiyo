import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { YACHIYO_CONNECT_SERVER } from '@yachiyo/shared/protocol'

import { RelayActivation } from './relayActivation.ts'
import { plaintextSecretBox } from './pairingStore.ts'

const hostId = 'A'.repeat(22)
const signed = (type: 'invite' | 'host', exp: number, id = hostId): string =>
  `${Buffer.from(JSON.stringify({ v: 1, t: type, id, exp })).toString('base64url')}.${'S'.repeat(43)}`

test('redeems a signed invitation and persists only the encrypted, expiring host credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-activation-'))
  const now = 1_800_000_000_000
  const invite = signed('invite', now + 60_000)
  const key = signed('host', now + 60_000)
  const wrap = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0xff))
  const activation = new RelayActivation(
    directory,
    { encrypt: wrap, decrypt: wrap },
    async (url, init) => {
      assert.equal(url, `${YACHIYO_CONNECT_SERVER}/v1/invitations/redeem`)
      assert.deepEqual(JSON.parse(String(init?.body)), { code: invite })
      return new Response(JSON.stringify({ hostId, key }), { status: 200 })
    },
    () => now
  )
  try {
    assert.deepEqual(await activation.redeem(invite), { hostId })
    const file = await readFile(join(directory, 'relay-activation.bin'), 'utf8')
    assert.equal(file.includes(key), false)
    assert.equal(file.includes(invite), false)
    assert.deepEqual(await activation.load(), { hostId, key, server: YACHIYO_CONNECT_SERVER })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('expired or wrong-purpose invitation is rejected before contacting the server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-activation-invalid-'))
  const now = 1_800_000_000_000
  let calls = 0
  const activation = new RelayActivation(
    directory,
    plaintextSecretBox,
    async () => {
      calls++
      return new Response('{}')
    },
    () => now
  )
  try {
    for (const code of [
      signed('invite', now),
      signed('host', now + 60_000),
      'A'.repeat(43),
      'A'.repeat(225)
    ]) {
      await assert.rejects(activation.redeem(code), /valid invitation/)
    }
    assert.equal(calls, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('redemption response cannot change identity, purpose, or extend the invitation lifetime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-activation-response-'))
  const now = 1_800_000_000_000
  const exp = now + 60_000
  let key = signed('host', exp, 'B'.repeat(22))
  const activation = new RelayActivation(
    directory,
    plaintextSecretBox,
    async () => new Response(JSON.stringify({ hostId, key })),
    () => now
  )
  try {
    for (const invalid of [
      signed('host', exp, 'B'.repeat(22)),
      signed('invite', exp),
      signed('host', exp + 1),
      signed('host', now)
    ]) {
      key = invalid
      await assert.rejects(activation.redeem(signed('invite', exp)), /response is invalid/)
    }
    assert.equal(await activation.load(), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stored activation expires rather than continuing to report an activated host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-activation-expiry-'))
  let now = 1_800_000_000_000
  const exp = now + 60_000
  const activation = new RelayActivation(
    directory,
    plaintextSecretBox,
    async () => new Response(JSON.stringify({ hostId, key: signed('host', exp) })),
    () => now
  )
  try {
    await activation.redeem(signed('invite', exp))
    assert.equal((await activation.load())?.hostId, hostId)
    now = exp
    assert.equal(await activation.load(), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('activation for a retired or custom server cannot authorize built-in Connect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connect-retired-activation-'))
  const now = 1_800_000_000_000
  const activation = new RelayActivation(directory, plaintextSecretBox, fetch, () => now)
  try {
    await writeFile(
      join(directory, 'relay-activation.bin'),
      JSON.stringify({
        server: 'https://retired.example',
        hostId,
        key: signed('host', now + 60000)
      })
    )
    assert.equal(await activation.load(), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
