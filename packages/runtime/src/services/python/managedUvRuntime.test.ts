import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { crc32, gzipSync } from 'node:zlib'
import * as tar from 'tar-stream'

import { PY_REPL_UV_VERSION } from './managedPythonConstants.ts'
import { ManagedPythonEnvironmentError } from './managedPythonEnvironmentState.ts'
import {
  getManagedUvCachePaths,
  getUvReleaseAsset,
  resolveDownloadedUv,
  type ManagedUvPaths,
  type UvReleaseAsset
} from './managedUvRuntime.ts'

async function createPaths(t: test.TestContext): Promise<ManagedUvPaths> {
  const temporaryPath = await mkdtemp(join(tmpdir(), 'yachiyo-managed-uv-'))
  t.after(async () => rm(temporaryPath, { recursive: true, force: true }))
  const homePath = await realpath(temporaryPath)
  const rootPath = join(homePath, 'python')
  const toolsPath = join(rootPath, 'tools')
  await mkdir(toolsPath, { recursive: true, mode: 0o700 })
  return { homePath, rootPath, toolsPath }
}

async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

async function createTarGz(entryName: string, content: Buffer): Promise<Buffer> {
  const pack = tar.pack()
  const collecting = collect(pack)
  const ignored = Buffer.from('ignored release metadata')
  pack.entry(
    { name: 'uv-test/README.md', type: 'file', mode: 0o644, size: ignored.byteLength },
    ignored
  )
  pack.entry({ name: entryName, type: 'file', mode: 0o755, size: content.byteLength }, content)
  pack.finalize()
  return gzipSync(await collecting)
}

function createStoredZip(entryName: string, content: Buffer): Buffer {
  const name = Buffer.from(entryName)
  const checksum = crc32(content)
  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(0, 6)
  localHeader.writeUInt16LE(0, 8)
  localHeader.writeUInt32LE(checksum, 14)
  localHeader.writeUInt32LE(content.byteLength, 18)
  localHeader.writeUInt32LE(content.byteLength, 22)
  localHeader.writeUInt16LE(name.byteLength, 26)

  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(0x02014b50, 0)
  centralHeader.writeUInt16LE(20, 4)
  centralHeader.writeUInt16LE(20, 6)
  centralHeader.writeUInt16LE(0, 8)
  centralHeader.writeUInt16LE(0, 10)
  centralHeader.writeUInt32LE(checksum, 16)
  centralHeader.writeUInt32LE(content.byteLength, 20)
  centralHeader.writeUInt32LE(content.byteLength, 24)
  centralHeader.writeUInt16LE(name.byteLength, 28)

  const centralOffset = localHeader.byteLength + name.byteLength + content.byteLength
  const centralSize = centralHeader.byteLength + name.byteLength
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([localHeader, name, content, centralHeader, name, end])
}

function releaseFor(archive: Buffer, overrides: Partial<UvReleaseAsset> = {}): UvReleaseAsset {
  return {
    platform: 'darwin',
    arch: 'arm64',
    targetTriple: 'test-target',
    version: PY_REPL_UV_VERSION,
    url: 'https://example.test/uv.tar.gz',
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
    archiveEntry: 'uv-test/uv',
    archiveType: 'tar.gz',
    outputName: 'uv',
    ...overrides
  }
}

function archiveResponse(archive: Buffer): Response {
  return new Response(new Uint8Array(archive), {
    status: 200,
    headers: { 'content-length': String(archive.byteLength) }
  })
}

test('pins every supported uv release target outside the bundled asset manifest', () => {
  assert.deepEqual(getUvReleaseAsset('darwin', 'arm64'), {
    platform: 'darwin',
    arch: 'arm64',
    targetTriple: 'aarch64-apple-darwin',
    version: '0.12.7',
    url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-aarch64-apple-darwin.tar.gz',
    archiveSha256: '127ebdda7ad953cdf198e964b570ea5771b85467ea93eb7cb6d6f8e6f55408f3',
    archiveEntry: 'uv-aarch64-apple-darwin/uv',
    archiveType: 'tar.gz',
    outputName: 'uv'
  })
  assert.equal(
    getUvReleaseAsset('darwin', 'x64')?.archiveSha256,
    '06b8ae1da8c2661c5434507a66f8c2b0b835933bf955b5958a9ac357a37d1959'
  )
  assert.equal(
    getUvReleaseAsset('linux', 'arm64')?.archiveSha256,
    '66393193038dd7eb108abd7a218d9cec04ac70ab98242b0720fa94de19223b7c'
  )
  assert.equal(
    getUvReleaseAsset('linux', 'x64')?.archiveSha256,
    '788f18abea7c5f55d6216e4f5613fd89d4d59b631efeec117b2b07fe72f1da21'
  )
  assert.deepEqual(getUvReleaseAsset('win32', 'x64'), {
    platform: 'win32',
    arch: 'x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    version: '0.12.7',
    url: 'https://github.com/astral-sh/uv/releases/download/0.12.7/uv-x86_64-pc-windows-msvc.zip',
    archiveSha256: 'bf1518af459a3915511a11fdc6e2f43ef9a2afa138b9d498eeb9642fe9d85218',
    archiveEntry: 'uv.exe',
    archiveType: 'zip',
    outputName: 'uv.exe'
  })
  assert.equal(getUvReleaseAsset('win32', 'arm64'), undefined)
})

test('downloads, verifies, and reuses a managed uv tar release', async (t) => {
  const paths = await createPaths(t)
  const executable = Buffer.from('#!/bin/sh\necho uv\n')
  const archive = await createTarGz('uv-test/uv', executable)
  const release = releaseFor(archive)
  let fetchCount = 0
  const fetchImpl: typeof fetch = async () => {
    fetchCount += 1
    return archiveResponse(archive)
  }

  const executablePath = await resolveDownloadedUv(
    paths,
    new AbortController().signal,
    Date.now() + 5_000,
    {
      release,
      fetch: fetchImpl
    }
  )
  assert.equal(fetchCount, 1)
  assert.deepEqual(await readFile(executablePath), executable)
  if (process.platform !== 'win32') {
    assert.equal((await stat(executablePath)).mode & 0o777, 0o700)
  }

  const cachePaths = getManagedUvCachePaths(paths, release)
  assert.equal(executablePath, cachePaths.executablePath)
  assert.deepEqual(JSON.parse(await readFile(cachePaths.metadataPath, 'utf8')), {
    schemaVersion: 1,
    version: release.version,
    platform: release.platform,
    arch: release.arch,
    targetTriple: release.targetTriple,
    archiveSha256: release.archiveSha256,
    outputSha256: createHash('sha256').update(executable).digest('hex')
  })

  const reusedPath = await resolveDownloadedUv(
    paths,
    new AbortController().signal,
    Date.now() + 5_000,
    {
      release,
      fetch: async () => {
        throw new Error('cache reuse must not fetch')
      }
    }
  )
  assert.equal(reusedPath, executablePath)

  await writeFile(executablePath, 'tampered')
  await resolveDownloadedUv(paths, new AbortController().signal, Date.now() + 5_000, {
    release,
    fetch: fetchImpl
  })
  assert.equal(fetchCount, 2)
  assert.deepEqual(await readFile(executablePath), executable)
  assert.deepEqual(
    (await readdir(paths.toolsPath)).filter((name) => name.endsWith('.tmp')),
    []
  )
})

test('extracts the pinned entry from a managed uv zip release', async (t) => {
  const paths = await createPaths(t)
  const executable = Buffer.from('windows uv executable')
  const archive = createStoredZip('uv.exe', executable)
  const release = releaseFor(archive, {
    platform: 'win32',
    arch: 'x64',
    targetTriple: 'test-windows-target',
    url: 'https://example.test/uv.zip',
    archiveEntry: 'uv.exe',
    archiveType: 'zip',
    outputName: 'uv.exe'
  })

  const executablePath = await resolveDownloadedUv(
    paths,
    new AbortController().signal,
    Date.now() + 5_000,
    {
      release,
      fetch: async () => archiveResponse(archive)
    }
  )
  assert.deepEqual(await readFile(executablePath), executable)
})

test('rejects an archive whose SHA-256 does not match the pinned release', async (t) => {
  const paths = await createPaths(t)
  const archive = await createTarGz('uv-test/uv', Buffer.from('uv'))
  const release = releaseFor(archive, { archiveSha256: '0'.repeat(64) })
  await assert.rejects(
    resolveDownloadedUv(paths, new AbortController().signal, Date.now() + 5_000, {
      release,
      fetch: async () => archiveResponse(archive)
    }),
    (error: unknown) =>
      error instanceof ManagedPythonEnvironmentError && error.code === 'resources-invalid'
  )
  const cachePaths = getManagedUvCachePaths(paths, release)
  await assert.rejects(readFile(cachePaths.executablePath), { code: 'ENOENT' })
  assert.deepEqual(
    (await readdir(paths.toolsPath)).filter((name) => name.endsWith('.tmp')),
    []
  )
})

test('reports HTTP failures as managed Python network failures', async (t) => {
  const paths = await createPaths(t)
  const release = releaseFor(Buffer.from('unused'))
  await assert.rejects(
    resolveDownloadedUv(paths, new AbortController().signal, Date.now() + 5_000, {
      release,
      fetch: async () => new Response('unavailable', { status: 503 })
    }),
    (error: unknown) => error instanceof ManagedPythonEnvironmentError && error.code === 'network'
  )
})

test('does not fetch uv after cancellation', async (t) => {
  const paths = await createPaths(t)
  const release = releaseFor(Buffer.from('unused'))
  const controller = new AbortController()
  controller.abort()
  let fetched = false
  await assert.rejects(
    resolveDownloadedUv(paths, controller.signal, Date.now() + 5_000, {
      release,
      fetch: async () => {
        fetched = true
        return new Response()
      }
    }),
    { name: 'AbortError' }
  )
  assert.equal(fetched, false)
})
