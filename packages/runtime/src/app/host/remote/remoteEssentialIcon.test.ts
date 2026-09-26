import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import sharp from 'sharp'

import { readEssentialIcon } from './remoteEssentialIcon.ts'
import { createRemoteHostOps, type RemoteProjectionServer } from './remoteHostOps.ts'
import { MAX_REMOTE_FILE_BYTES } from './remoteWorkspaceFile.ts'

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="256"><rect width="1024" height="256" fill="red"/></svg>'
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

test('Essential data images do not use Electron network fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('net::ERR_INVALID_ARGUMENT')
  })
  const base64 = await readEssentialIcon(dataUrl)
  const percentEncoded = await readEssentialIcon(`data:image/svg+xml,${encodeURIComponent(svg)}`)
  assert.deepEqual(percentEncoded, base64)
  assert.equal(base64.mediaType, 'image/png')
  assert.equal((await sharp(Buffer.from(base64.data, 'base64')).metadata()).width, 512)
})

test('Essential data images are normalized to bounded UIKit-compatible PNG', async () => {
  const image = await readEssentialIcon(dataUrl)
  assert.equal(image.mediaType, 'image/png')
  const metadata = await sharp(Buffer.from(image.data, 'base64')).metadata()
  assert.equal(metadata.width, 512)
  assert.equal(metadata.height, 128)
})

test('Essential PNG data supports large base64 and percent-encoded binary without fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('net::ERR_INVALID_ARGUMENT')
  })
  const png = await sharp(randomBytes(384 * 384 * 3), {
    raw: { width: 384, height: 384, channels: 3 }
  })
    .png()
    .toBuffer()
  assert.ok(png.length > 300_000)
  const base64 = await readEssentialIcon(`data:image/png;base64,${png.toString('base64')}`)
  const percentEncoded = await readEssentialIcon(
    `data:image/png,${Array.from(png, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')}`
  )
  assert.deepEqual(percentEncoded, base64)
  const metadata = await sharp(Buffer.from(base64.data, 'base64')).metadata()
  assert.equal(metadata.width, 384)
  assert.equal(metadata.height, 384)
})

test('Essential images support trusted local paths and file URLs, including reserved characters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'essential-icon-'))
  try {
    const path = join(dir, 'image #100%.svg')
    await writeFile(path, svg)
    const expected = await readEssentialIcon(dataUrl)
    assert.deepEqual(await readEssentialIcon(path), expected)
    assert.deepEqual(await readEssentialIcon(pathToFileURL(path).href), expected)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Essential remote URLs use the host and reject failed or oversized responses', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/missing') {
      response.writeHead(404).end()
      return
    }
    response.end(request.url === '/large' ? Buffer.alloc(MAX_REMOTE_FILE_BYTES + 1) : svg)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    assert.deepEqual(await readEssentialIcon(`${base}/icon`), await readEssentialIcon(dataUrl))
    await assert.rejects(readEssentialIcon(`${base}/missing`), /could not be loaded/)
    await assert.rejects(readEssentialIcon(`${base}/large`), /too large/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('Essential icons reject unsupported, invalid, and oversized data sources', async () => {
  await assert.rejects(readEssentialIcon('ftp://example.com/icon.png'), /Unsupported/)
  await assert.rejects(readEssentialIcon('data:text/plain,not-an-image'))
  await assert.rejects(readEssentialIcon('data:image/png;base64'))
  await assert.rejects(readEssentialIcon('data:image/png,%89%XX'))
  await assert.rejects(
    readEssentialIcon(`data:image/png;base64,${'A'.repeat(MAX_REMOTE_FILE_BYTES * 2)}`),
    /too large/
  )
  await assert.rejects(
    readEssentialIcon(`data:image/png,${'%41'.repeat(MAX_REMOTE_FILE_BYTES + 1)}`),
    /too large/
  )
})

test('Essential projection keeps emoji semantics and retrieves image bytes only by configured ID', async () => {
  const config = {
    essentials: [
      { id: 'emoji', iconType: 'emoji', icon: '🧪', order: 0 },
      { id: 'image', iconType: 'image', icon: dataUrl, order: 1 }
    ]
  }
  const ops = createRemoteHostOps({ getConfig: async () => config } as RemoteProjectionServer)
  assert.deepEqual((await ops['host.remote.listEssentials']()).essentials, [
    { id: 'emoji', icon: '🧪', privacyMode: false, order: 0 },
    {
      id: 'image',
      hasImageIcon: true,
      iconVersion: (await readEssentialIcon(dataUrl)).iconVersion,
      privacyMode: false,
      order: 1
    }
  ])
  assert.deepEqual(
    await ops['host.remote.getEssentialIcon']({ essentialId: 'image' }),
    await readEssentialIcon(dataUrl)
  )
  await assert.rejects(ops['host.remote.getEssentialIcon']({ essentialId: 'emoji' }), /not found/)
  const previous = (await ops['host.remote.listEssentials']()).essentials[1]!.iconVersion
  config.essentials[1]!.icon = dataUrl.replace(
    Buffer.from(svg).toString('base64'),
    Buffer.from(svg.replace('red', 'blue')).toString('base64')
  )
  const changed = await ops['host.remote.getEssentialIcon']({ essentialId: 'image' })
  assert.notEqual(changed.iconVersion, previous)
  assert.equal(
    (await ops['host.remote.listEssentials']()).essentials[1]!.iconVersion,
    changed.iconVersion
  )
  await assert.rejects(
    ops['host.remote.getEssentialIcon']({ essentialId: '/etc/passwd' }),
    /not found/
  )
})

test('Essential listing never fetches HTTP icons and tolerates broken local icons', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Metadata must not fetch remote icons')
  })
  const config = {
    essentials: [
      { id: 'url', iconType: 'image', icon: 'https://example.com/icon.png', order: 0 },
      { id: 'broken', iconType: 'image', icon: 'data:image/png,broken', order: 1 }
    ]
  }
  const ops = createRemoteHostOps({ getConfig: async () => config } as RemoteProjectionServer)
  const { essentials } = await ops['host.remote.listEssentials']()
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(essentials.length, 2)
  assert.ok(essentials.every((essential) => essential.hasImageIcon && !essential.iconVersion))
})

test('Essential listing versions local file content changed at the same path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'essential-version-'))
  try {
    const path = join(dir, 'icon.svg')
    await writeFile(path, svg)
    const config = { essentials: [{ id: 'file', iconType: 'image', icon: path, order: 0 }] }
    const ops = createRemoteHostOps({ getConfig: async () => config } as RemoteProjectionServer)
    const before = (await ops['host.remote.listEssentials']()).essentials[0]!.iconVersion
    assert.ok(before)
    await writeFile(path, svg.replace('red', 'blue'))
    const after = (await ops['host.remote.listEssentials']()).essentials[0]!.iconVersion
    assert.ok(after)
    assert.notEqual(after, before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Essential icon versions are reused until the file path, mtime or size changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'essential-cache-'))
  try {
    const path = join(dir, 'icon.svg')
    await writeFile(path, svg)
    const mtime = new Date('2026-01-01T00:00:00.000Z')
    await utimes(path, mtime, mtime)
    const config = { essentials: [{ id: 'file', iconType: 'image', icon: path, order: 0 }] }
    const ops = createRemoteHostOps({ getConfig: async () => config } as RemoteProjectionServer)
    const first = (await ops['host.remote.listEssentials']()).essentials[0]!.iconVersion
    assert.ok(first)

    // Same size and mtime: served from the cache without decoding the file again.
    await writeFile(path, svg.replace('red', 'tan'))
    await utimes(path, mtime, mtime)
    assert.equal((await ops['host.remote.listEssentials']()).essentials[0]!.iconVersion, first)
    assert.equal(
      (await ops['host.remote.getEssentialIcon']({ essentialId: 'file' })).iconVersion,
      first
    )

    await utimes(path, mtime, new Date(mtime.getTime() + 5000))
    const touched = (await ops['host.remote.listEssentials']()).essentials[0]!.iconVersion
    assert.ok(touched)
    assert.notEqual(touched, first)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
