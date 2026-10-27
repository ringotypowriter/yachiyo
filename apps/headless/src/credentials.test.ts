import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { access, chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createHeadlessProviderVault,
  createHeadlessSecretBox,
  initializeMasterKey,
  readMasterKey,
  resolveMasterKeyPath
} from './credentials.ts'
import { initializeHeadless } from './initialize.ts'

test('initialization preserves an existing key and rejects unsafe key files', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'yh-key-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const path = join(home, 'master.key')
  initializeMasterKey(path)
  const key = readMasterKey(path)
  assert.equal(key.length, 32)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  initializeMasterKey(path)
  assert.deepEqual(readMasterKey(path), key)
  await chmod(path, 0o644)
  assert.throws(() => readMasterKey(path), /owner/)
  await chmod(path, 0o400)
  assert.deepEqual(readMasterKey(path), key)
  const link = join(home, 'link')
  await symlink(path, link)
  assert.throws(() => readMasterKey(link))
  const short = join(home, 'short')
  await writeFile(short, 'not-a-key', { mode: 0o600 })
  assert.throws(() => readMasterKey(short), /32-byte/)
  assert.equal(
    resolveMasterKeyPath(home, { CREDENTIALS_DIRECTORY: '/run/credentials/unit' }),
    '/run/credentials/unit/yachiyo-master-key'
  )
  assert.equal(
    resolveMasterKeyPath(home, {
      CREDENTIALS_DIRECTORY: '/run/credentials/unit',
      YACHIYO_MASTER_KEY_FILE: path
    }),
    path
  )
})

test('provider and Remote secrets survive restart and reject tampering or the wrong key', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'yh-secret-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const key = randomBytes(32)
  const secrets = { provider: { apiKey: 'sk-private-test-value' } }
  createHeadlessProviderVault(home, key).write(secrets)
  assert.deepEqual(createHeadlessProviderVault(home, key).read(), secrets)
  assert.ok(
    !(await readFile(join(home, 'provider-credentials.enc'), 'utf8')).includes(
      secrets.provider.apiKey
    )
  )
  assert.throws(() => createHeadlessProviderVault(home, randomBytes(32)).read())

  const plaintext = Buffer.from('remote-identity-secret')
  const encoded = createHeadlessSecretBox(key).encrypt(plaintext)
  assert.ok(!encoded.includes(plaintext))
  assert.deepEqual(createHeadlessSecretBox(key).decrypt(encoded), plaintext)
  assert.throws(() => createHeadlessSecretBox(randomBytes(32)).decrypt(encoded))
  const tampered = Buffer.from(encoded)
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => createHeadlessSecretBox(key).decrypt(tampered))
  assert.throws(() => createHeadlessSecretBox(key).decrypt(Buffer.from('legacy-plaintext')))

  await writeFile(join(home, 'provider-credentials.key'), 'desktop-wallet')
  assert.throws(() => createHeadlessProviderVault(home, key), /desktop wallet/)
})

test('init refuses a desktop data directory before generating a new master key', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'yh-desktop-'))
  const previousKeyPath = process.env.YACHIYO_MASTER_KEY_FILE
  const path = join(home, 'headless-master.key')
  process.env.YACHIYO_MASTER_KEY_FILE = path
  t.after(async () => {
    if (previousKeyPath === undefined) delete process.env.YACHIYO_MASTER_KEY_FILE
    else process.env.YACHIYO_MASTER_KEY_FILE = previousKeyPath
    await rm(home, { recursive: true, force: true })
  })
  await writeFile(join(home, 'provider-credentials.key'), 'desktop-key')
  assert.throws(() => initializeHeadless(home), /desktop wallet/)
  await assert.rejects(access(path), { code: 'ENOENT' })
})
