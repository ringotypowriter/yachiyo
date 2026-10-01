import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RelayActivation } from './relayActivation.ts'

test('redeems invitation over HTTPS and persists encrypted host credential without invitation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-activation-'))
  const key = 'K'.repeat(43)
  const wrap = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0xff))
  const activation = new RelayActivation(
    directory,
    {
      encrypt: wrap,
      decrypt: wrap
    },
    async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { code: 'A'.repeat(43) })
      return new Response(JSON.stringify({ hostId: 'mac-1', key }), { status: 200 })
    }
  )
  try {
    assert.deepEqual(await activation.redeem('https://relay.example', 'A'.repeat(43)), {
      hostId: 'mac-1'
    })
    const file = await readFile(join(directory, 'relay-activation.bin'), 'utf8')
    assert.equal(file.includes(key), false)
    assert.equal(file.includes('A'.repeat(43)), false)
    assert.deepEqual(await activation.load(), {
      hostId: 'mac-1',
      key,
      server: 'https://relay.example'
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
