import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  pruneExpiredPairingQrImages,
  prunePairingQrImagesOnStartup,
  storePairingQrImage
} from './pairingQrImage.ts'

test('startup pruning removes stale QR files without creating a directory or generating a QR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo qr prune '))
  const directory = join(root, 'QR Images')
  const stale = join(directory, '00000000-0000-4000-8000-000000000000.png')
  const recent = join(directory, '00000000-0000-4000-8000-000000000001.png')
  const now = Date.now()
  try {
    await prunePairingQrImagesOnStartup(directory)
    await assert.rejects(stat(directory), { code: 'ENOENT' })
    await mkdir(directory)
    await writeFile(stale, 'stale')
    await writeFile(recent, 'recent')
    await utimes(stale, new Date(now - 360_000), new Date(now - 360_000))
    await pruneExpiredPairingQrImages(directory, now)
    await assert.rejects(stat(stale), { code: 'ENOENT' })
    assert.equal(await readFile(recent, 'utf8'), 'recent')
    await writeFile(stale, 'stale')
    await prunePairingQrImagesOnStartup(directory)
    await assert.rejects(stat(stale), { code: 'ENOENT' })
    await assert.rejects(stat(recent), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stores a private PNG in a path with spaces and removes expired artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo pairing qr '))
  const directory = join(root, 'QR Images')
  const now = Date.now()
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  try {
    const first = await storePairingQrImage({
      png,
      expiresAt: new Date(now + 60_000).toISOString(),
      directory,
      now: () => now
    })
    assert.ok(first.startsWith(`${directory}/`))
    assert.deepEqual(await readFile(first), png)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(first)).mode & 0o777, 0o600)

    const stale = join(directory, '00000000-0000-4000-8000-000000000000.png')
    await writeFile(stale, png)
    await utimes(stale, new Date(now - 360_000), new Date(now - 360_000))
    await storePairingQrImage({
      png,
      expiresAt: new Date(now + 60_000).toISOString(),
      directory,
      now: () => now
    })
    assert.equal(
      (await readdir(directory)).includes('00000000-0000-4000-8000-000000000000.png'),
      false
    )
    assert.deepEqual(await readFile(first), png)
    await assert.rejects(
      storePairingQrImage({
        png,
        expiresAt: new Date(now - 1).toISOString(),
        directory,
        now: () => now
      }),
      /expiry/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removes a stored QR at its expiry while the process is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo qr expiry '))
  try {
    const imagePath = await storePairingQrImage({
      png: Buffer.from('89504e470d0a1a0a', 'hex'),
      expiresAt: new Date(Date.now() + 100).toISOString(),
      directory: join(root, 'QR Images')
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    await assert.rejects(stat(imagePath), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
