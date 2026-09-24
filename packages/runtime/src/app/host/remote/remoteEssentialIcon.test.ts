import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

test('Essential data images are normalized to bounded UIKit-compatible PNG', async () => {
  const image = await readEssentialIcon(dataUrl)
  assert.equal(image.mediaType, 'image/png')
  const metadata = await sharp(Buffer.from(image.data, 'base64')).metadata()
  assert.equal(metadata.width, 512)
  assert.equal(metadata.height, 128)
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
  await assert.rejects(
    readEssentialIcon(`data:image/png;base64,${'A'.repeat(MAX_REMOTE_FILE_BYTES * 2)}`),
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
    { id: 'image', hasImageIcon: true, privacyMode: false, order: 1 }
  ])
  assert.deepEqual(
    await ops['host.remote.getEssentialIcon']({ essentialId: 'image' }),
    await readEssentialIcon(dataUrl)
  )
  await assert.rejects(ops['host.remote.getEssentialIcon']({ essentialId: 'emoji' }), /not found/)
  await assert.rejects(
    ops['host.remote.getEssentialIcon']({ essentialId: '/etc/passwd' }),
    /not found/
  )
})
