import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, open, rename, rm, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import * as tar from 'tar-stream'
import * as yauzl from 'yauzl'

import { PY_REPL_UV_VERSION } from './managedPythonConstants.ts'
import { ManagedPythonEnvironmentError } from './managedPythonEnvironmentState.ts'
import {
  assertManagedDirectory,
  hashFile,
  isNodeError,
  readBoundedFile,
  token,
  writePrivateFile
} from './managedPythonFilesystem.ts'
import { hasExactKeys, parseStrictObject } from './managedPythonMetadata.ts'

const UV_CACHE_SCHEMA_VERSION = 1
const UV_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024
const UV_EXECUTABLE_MAX_BYTES = 128 * 1024 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

export interface UvReleaseAsset {
  platform: NodeJS.Platform
  arch: string
  targetTriple: string
  version: string
  url: string
  archiveSha256: string
  archiveEntry: string
  archiveType: 'tar.gz' | 'zip'
  outputName: 'uv' | 'uv.exe'
}

interface UvCacheMetadata {
  schemaVersion: number
  version: string
  platform: string
  arch: string
  targetTriple: string
  archiveSha256: string
  outputSha256: string
}

export interface ManagedUvPaths {
  homePath: string
  rootPath: string
  toolsPath: string
}

interface ResolveDownloadedUvOptions {
  release?: UvReleaseAsset
  fetch?: typeof fetch
}

const UV_RELEASES: Readonly<Record<string, UvReleaseAsset>> = {
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    targetTriple: 'aarch64-apple-darwin',
    version: PY_REPL_UV_VERSION,
    url: `https://github.com/astral-sh/uv/releases/download/${PY_REPL_UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`,
    archiveSha256: '127ebdda7ad953cdf198e964b570ea5771b85467ea93eb7cb6d6f8e6f55408f3',
    archiveEntry: 'uv-aarch64-apple-darwin/uv',
    archiveType: 'tar.gz',
    outputName: 'uv'
  },
  'darwin-x64': {
    platform: 'darwin',
    arch: 'x64',
    targetTriple: 'x86_64-apple-darwin',
    version: PY_REPL_UV_VERSION,
    url: `https://github.com/astral-sh/uv/releases/download/${PY_REPL_UV_VERSION}/uv-x86_64-apple-darwin.tar.gz`,
    archiveSha256: '06b8ae1da8c2661c5434507a66f8c2b0b835933bf955b5958a9ac357a37d1959',
    archiveEntry: 'uv-x86_64-apple-darwin/uv',
    archiveType: 'tar.gz',
    outputName: 'uv'
  },
  'linux-arm64': {
    platform: 'linux',
    arch: 'arm64',
    targetTriple: 'aarch64-unknown-linux-gnu',
    version: PY_REPL_UV_VERSION,
    url: `https://github.com/astral-sh/uv/releases/download/${PY_REPL_UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz`,
    archiveSha256: '66393193038dd7eb108abd7a218d9cec04ac70ab98242b0720fa94de19223b7c',
    archiveEntry: 'uv-aarch64-unknown-linux-gnu/uv',
    archiveType: 'tar.gz',
    outputName: 'uv'
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    targetTriple: 'x86_64-unknown-linux-gnu',
    version: PY_REPL_UV_VERSION,
    url: `https://github.com/astral-sh/uv/releases/download/${PY_REPL_UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`,
    archiveSha256: '788f18abea7c5f55d6216e4f5613fd89d4d59b631efeec117b2b07fe72f1da21',
    archiveEntry: 'uv-x86_64-unknown-linux-gnu/uv',
    archiveType: 'tar.gz',
    outputName: 'uv'
  },
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    version: PY_REPL_UV_VERSION,
    url: `https://github.com/astral-sh/uv/releases/download/${PY_REPL_UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
    archiveSha256: 'bf1518af459a3915511a11fdc6e2f43ef9a2afa138b9d498eeb9642fe9d85218',
    archiveEntry: 'uv.exe',
    archiveType: 'zip',
    outputName: 'uv.exe'
  }
}

class UvDownloadError extends Error {}
class UvIntegrityError extends Error {}

export function getUvReleaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): UvReleaseAsset | undefined {
  return UV_RELEASES[`${platform}-${arch}`]
}

export function getManagedUvCachePaths(
  paths: ManagedUvPaths,
  release: UvReleaseAsset
): { executablePath: string; metadataPath: string } {
  const executablePath = join(
    paths.toolsPath,
    `uv-${release.version}-${release.targetTriple}-${release.archiveSha256.slice(0, 16)}${release.outputName.endsWith('.exe') ? '.exe' : ''}`
  )
  return { executablePath, metadataPath: `${executablePath}.json` }
}

function abortError(): Error {
  const error = new Error('The Yachiyo Python runtime preparation was aborted.')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function isPermissionError(error: unknown): boolean {
  return isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM') || isNodeError(error, 'EROFS')
}

function cacheMetadata(release: UvReleaseAsset, outputSha256: string): UvCacheMetadata {
  return {
    schemaVersion: UV_CACHE_SCHEMA_VERSION,
    version: release.version,
    platform: release.platform,
    arch: release.arch,
    targetTriple: release.targetTriple,
    archiveSha256: release.archiveSha256,
    outputSha256
  }
}

function parseCacheMetadata(value: string): UvCacheMetadata {
  const parsed = parseStrictObject(value)
  const keys = [
    'schemaVersion',
    'version',
    'platform',
    'arch',
    'targetTriple',
    'archiveSha256',
    'outputSha256'
  ] as const
  if (
    !hasExactKeys(parsed, keys) ||
    typeof parsed['schemaVersion'] !== 'number' ||
    keys.slice(1).some((key) => typeof parsed[key] !== 'string')
  ) {
    throw new Error('Managed uv cache metadata is malformed.')
  }
  return parsed as unknown as UvCacheMetadata
}

async function verifyCachedUv(
  executablePath: string,
  metadataPath: string,
  release: UvReleaseAsset
): Promise<boolean> {
  try {
    const metadata = parseCacheMetadata(await readBoundedFile(metadataPath, 16 * 1024))
    const expected = cacheMetadata(release, metadata.outputSha256)
    if (
      !SHA256_PATTERN.test(metadata.outputSha256) ||
      Object.entries(expected).some(
        ([key, value]) => metadata[key as keyof UvCacheMetadata] !== value
      )
    ) {
      return false
    }
    const executableStat = await lstat(executablePath)
    if (
      !executableStat.isFile() ||
      executableStat.isSymbolicLink() ||
      executableStat.size > UV_EXECUTABLE_MAX_BYTES ||
      (await hashFile(executablePath)) !== metadata.outputSha256
    ) {
      return false
    }
    if (process.platform !== 'win32') await chmod(executablePath, 0o700)
    return true
  } catch (error) {
    if (isPermissionError(error)) throw error
    return false
  }
}

async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset)
    if (bytesWritten === 0) throw new Error('Could not finish writing the managed uv runtime.')
    offset += bytesWritten
  }
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  if (typeof chunk === 'string') return Buffer.from(chunk)
  throw new UvIntegrityError('The uv release contained an unsupported data chunk.')
}

async function downloadArchive(
  release: UvReleaseAsset,
  archivePath: string,
  signal: AbortSignal,
  deadline: number,
  fetchImpl: typeof fetch
): Promise<void> {
  throwIfAborted(signal)
  if (Date.now() >= deadline) throw new UvDownloadError('The uv download timed out.')

  const controller = new AbortController()
  const abort = (): void => controller.abort(abortError())
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error('The uv download timed out.')),
    Math.max(1, deadline - Date.now())
  )
  let response: Response
  try {
    try {
      response = await fetchImpl(release.url, { redirect: 'follow', signal: controller.signal })
    } catch (error) {
      if (signal.aborted) throw abortError()
      if (Date.now() >= deadline) throw new UvDownloadError('The uv download timed out.')
      throw new UvDownloadError(`Could not fetch ${release.url}.`, { cause: error })
    }
    if (!response.ok || !response.body) {
      throw new UvDownloadError(`HTTP ${response.status} fetching ${release.url}.`)
    }
    const declaredSize = response.headers.get('content-length')
    if (
      declaredSize !== null &&
      (!/^\d+$/u.test(declaredSize) || Number(declaredSize) > UV_ARCHIVE_MAX_BYTES)
    ) {
      throw new UvIntegrityError('The uv release archive exceeds its allowed size.')
    }

    const hash = createHash('sha256')
    const file = await open(archivePath, 'wx', 0o600)
    let size = 0
    try {
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          throwIfAborted(signal)
          if (Date.now() >= deadline) throw new UvDownloadError('The uv download timed out.')
          const bytes = asBuffer(chunk)
          size += bytes.byteLength
          if (size > UV_ARCHIVE_MAX_BYTES) {
            throw new UvIntegrityError('The uv release archive exceeds its allowed size.')
          }
          hash.update(bytes)
          await writeAll(file, bytes)
        }
      } catch (error) {
        if (error instanceof UvIntegrityError || error instanceof UvDownloadError) throw error
        if (signal.aborted) throw abortError()
        if (isPermissionError(error)) throw error
        throw new UvDownloadError('The uv download ended before the archive was complete.', {
          cause: error
        })
      }
      await file.sync()
      if (process.platform !== 'win32') await file.chmod(0o600)
    } finally {
      await file.close()
    }
    const archiveSha256 = hash.digest('hex')
    if (archiveSha256 !== release.archiveSha256) {
      throw new UvIntegrityError(
        `The uv release archive failed SHA-256 verification: expected ${release.archiveSha256}, got ${archiveSha256}.`
      )
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

async function writeExecutable(
  stream: AsyncIterable<unknown>,
  destination: string
): Promise<string> {
  const hash = createHash('sha256')
  const file = await open(destination, 'wx', 0o700)
  let size = 0
  try {
    for await (const chunk of stream) {
      const bytes = asBuffer(chunk)
      size += bytes.byteLength
      if (size > UV_EXECUTABLE_MAX_BYTES) {
        throw new UvIntegrityError('The uv executable exceeds its allowed size.')
      }
      hash.update(bytes)
      await writeAll(file, bytes)
    }
    if (size === 0) throw new UvIntegrityError('The uv executable is empty.')
    await file.sync()
    if (process.platform !== 'win32') await file.chmod(0o700)
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

async function extractTarExecutable(
  archivePath: string,
  destination: string,
  release: UvReleaseAsset
): Promise<string> {
  const extractor = tar.extract()
  const parsing = pipeline(createReadStream(archivePath), createGunzip(), extractor)
  let outputSha256: string | undefined
  try {
    for await (const entry of extractor) {
      if (entry.header.name !== release.archiveEntry) {
        for await (const chunk of entry) {
          void chunk
        }
        continue
      }
      if (outputSha256 !== undefined || entry.header.type !== 'file') {
        throw new UvIntegrityError(`The uv release entry is invalid: ${release.archiveEntry}.`)
      }
      outputSha256 = await writeExecutable(entry, destination)
    }
    await parsing
  } catch (error) {
    extractor.destroy(error instanceof Error ? error : new Error(String(error)))
    await parsing.catch(() => undefined)
    if (error instanceof UvIntegrityError) throw error
    throw new UvIntegrityError('Could not extract the uv release archive.', { cause: error })
  }
  if (outputSha256 === undefined) {
    throw new UvIntegrityError(`The uv release entry is missing: ${release.archiveEntry}.`)
  }
  return outputSha256
}

async function extractZipExecutable(
  archivePath: string,
  destination: string,
  release: UvReleaseAsset
): Promise<string> {
  const zipFile = await yauzl.openPromise(archivePath, {
    autoClose: true,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true
  })
  let outputSha256: string | undefined
  try {
    for await (const entry of zipFile.eachEntry()) {
      if (entry.fileName !== release.archiveEntry) continue
      if (
        outputSha256 !== undefined ||
        entry.fileName.endsWith('/') ||
        entry.uncompressedSize > UV_EXECUTABLE_MAX_BYTES
      ) {
        throw new UvIntegrityError(`The uv release entry is invalid: ${release.archiveEntry}.`)
      }
      const stream = await zipFile.openReadStreamPromise(entry)
      outputSha256 = await writeExecutable(stream, destination)
    }
  } catch (error) {
    if (error instanceof UvIntegrityError) throw error
    throw new UvIntegrityError('Could not extract the uv release archive.', { cause: error })
  } finally {
    zipFile.close()
  }
  if (outputSha256 === undefined) {
    throw new UvIntegrityError(`The uv release entry is missing: ${release.archiveEntry}.`)
  }
  return outputSha256
}

async function replaceFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
  } catch (error) {
    let destinationStat
    try {
      destinationStat = await lstat(destination)
    } catch (statError) {
      if (isNodeError(statError, 'ENOENT')) throw error
      throw statError
    }
    if (!destinationStat.isFile() && !destinationStat.isSymbolicLink()) {
      throw new Error(`Managed uv target is not a replaceable file: ${destination}`)
    }
    await unlink(destination)
    await rename(source, destination)
  }
}

async function publishDownloadedUv(
  paths: ManagedUvPaths,
  release: UvReleaseAsset,
  temporaryExecutablePath: string,
  outputSha256: string
): Promise<string> {
  const { executablePath, metadataPath } = getManagedUvCachePaths(paths, release)
  const temporaryMetadataPath = join(paths.toolsPath, `.uv-${token()}.json.tmp`)
  await writePrivateFile(
    temporaryMetadataPath,
    `${JSON.stringify(cacheMetadata(release, outputSha256), null, 2)}\n`,
    true
  )
  try {
    await assertManagedDirectory(paths.toolsPath, paths.homePath)
    await replaceFile(temporaryExecutablePath, executablePath)
    await replaceFile(temporaryMetadataPath, metadataPath)
  } finally {
    await rm(temporaryMetadataPath, { force: true })
  }
  if (!(await verifyCachedUv(executablePath, metadataPath, release))) {
    throw new UvIntegrityError('The downloaded uv runtime failed verification after staging.')
  }
  return executablePath
}

function unsupportedTargetError(): ManagedPythonEnvironmentError {
  return new ManagedPythonEnvironmentError(
    `pyRepl cannot download uv ${PY_REPL_UV_VERSION} for ${process.platform}/${process.arch}. Update Yachiyo to a build that supports this platform.`,
    'resources-unavailable',
    'preparing-helper'
  )
}

function downloadFailure(error: unknown): ManagedPythonEnvironmentError {
  if (error instanceof UvDownloadError) {
    return new ManagedPythonEnvironmentError(
      `Could not download uv ${PY_REPL_UV_VERSION}. Check the network or proxy configuration and retry.`,
      'network',
      'preparing-helper',
      { cause: error }
    )
  }
  return new ManagedPythonEnvironmentError(
    `The downloaded uv ${PY_REPL_UV_VERSION} archive failed integrity verification. Retry the operation; if it fails again, update Yachiyo.`,
    'resources-invalid',
    'preparing-helper',
    { cause: error }
  )
}

export async function resolveDownloadedUv(
  paths: ManagedUvPaths,
  signal: AbortSignal,
  deadline: number,
  options: ResolveDownloadedUvOptions = {}
): Promise<string> {
  const release = options.release ?? getUvReleaseAsset()
  if (!release) throw unsupportedTargetError()
  const { executablePath, metadataPath } = getManagedUvCachePaths(paths, release)
  if (await verifyCachedUv(executablePath, metadataPath, release)) return executablePath

  await assertManagedDirectory(paths.toolsPath, paths.homePath)
  const temporaryArchivePath = join(paths.toolsPath, `.uv-${token()}.archive.tmp`)
  const temporaryExecutablePath = join(paths.toolsPath, `.uv-${token()}.executable.tmp`)
  try {
    await downloadArchive(release, temporaryArchivePath, signal, deadline, options.fetch ?? fetch)
    throwIfAborted(signal)
    const outputSha256 =
      release.archiveType === 'zip'
        ? await extractZipExecutable(temporaryArchivePath, temporaryExecutablePath, release)
        : await extractTarExecutable(temporaryArchivePath, temporaryExecutablePath, release)
    throwIfAborted(signal)
    return await publishDownloadedUv(paths, release, temporaryExecutablePath, outputSha256)
  } catch (error) {
    if (error instanceof ManagedPythonEnvironmentError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw error
    if (isPermissionError(error)) throw error
    throw downloadFailure(error)
  } finally {
    await rm(temporaryArchivePath, { force: true })
    await rm(temporaryExecutablePath, { force: true })
  }
}
