import { randomUUID } from 'node:crypto'
import { chmod, lstat, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

import { resolveBundledResource } from '../nativeExecutable.ts'
import type {
  ProcessBroker,
  ProcessJob,
  ProcessJobResult,
  ProcessOutputBatch
} from '../processBroker/processBroker.ts'
import { PY_REPL_UV_VERSION } from './managedPythonConstants.ts'
import { ManagedPythonEnvironmentError } from './managedPythonEnvironmentState.ts'
import {
  assertManagedDirectory,
  hashFile,
  isNodeError,
  readBoundedFile,
  token
} from './managedPythonFilesystem.ts'
import { hasExactKeys, parseStrictObject } from './managedPythonMetadata.ts'

export const MANAGED_PYTHON_JOB_OUTPUT_LIMIT_CHARS = 64_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const UV_RUNTIME_ARCHIVE_SUFFIX = '.runtime.gz'
const UV_RUNTIME_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024
const UV_EXECUTABLE_MAX_BYTES = 128 * 1024 * 1024
const TARGET_TRIPLES: Readonly<Partial<Record<NodeJS.Platform, Readonly<Record<string, string>>>>> =
  {
    darwin: {
      arm64: 'aarch64-apple-darwin',
      x64: 'x86_64-apple-darwin'
    },
    linux: {
      arm64: 'aarch64-unknown-linux-gnu',
      x64: 'x86_64-unknown-linux-gnu'
    },
    win32: {
      x64: 'x86_64-pc-windows-msvc'
    }
  }

interface UvAssetAttestation {
  name: string
  version: string
  platform: string
  arch: string
  targetTriple: string
  archiveSha256: string
  outputSha256: string
  runtimeArchiveSha256: string
}

export interface ManagedPythonBootstrapPaths {
  homePath: string
  rootPath: string
  toolsPath: string
}

export interface ManagedPythonResourceOptions {
  projectRoot?: string
  resourcesPath?: string
}

export interface ManagedPythonUvPreparation {
  paths: ManagedPythonBootstrapPaths
  uvPath: string
  bootstrapEnv: Readonly<NodeJS.ProcessEnv>
  processBroker: ProcessBroker
}

export interface ManagedJobResult {
  stdout: string
  stderr: string
  result: ProcessJobResult
}

const gunzipAsync = promisify(gunzip)

export function abortError(): Error {
  const error = new Error('The Yachiyo Python runtime preparation was aborted.')
  error.name = 'AbortError'
  return error
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function bundledUvError(
  options: ManagedPythonResourceOptions,
  code: 'resources-unavailable' | 'resources-invalid',
  cause?: unknown
): ManagedPythonEnvironmentError {
  const target = `${process.platform}/${process.arch}`
  const sourceMode = options.projectRoot !== undefined || !import.meta.dirname.includes('.asar')
  return new ManagedPythonEnvironmentError(
    sourceMode
      ? `pyRepl's bundled uv runtime is missing or invalid for ${target}. Run pnpm binaries:download.`
      : `This Yachiyo build does not contain a valid Python runtime resource for ${target}. Update Yachiyo to a build with valid Python resources.`,
    code,
    'preparing-helper',
    cause === undefined ? undefined : { cause }
  )
}

function parseAttestation(value: string): UvAssetAttestation {
  const parsed = parseStrictObject(value)
  const keys = [
    'name',
    'version',
    'platform',
    'arch',
    'targetTriple',
    'archiveSha256',
    'outputSha256',
    'runtimeArchiveSha256'
  ] as const
  if (!hasExactKeys(parsed, keys) || keys.some((key) => typeof parsed[key] !== 'string')) {
    throw new Error('Bundled uv attestation is malformed.')
  }
  return parsed as unknown as UvAssetAttestation
}

function appendBounded(current: string, text: string): string {
  const combined = current + text
  return combined.length <= MANAGED_PYTHON_JOB_OUTPUT_LIMIT_CHARS
    ? combined
    : combined.slice(combined.length - MANAGED_PYTHON_JOB_OUTPUT_LIMIT_CHARS)
}

function remainingSeconds(deadline: number): number {
  return Math.max(0.001, (deadline - Date.now()) / 1000)
}

export async function runManagedJob(input: {
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<NodeJS.ProcessEnv>
  paths: ManagedPythonBootstrapPaths
  processBroker: ProcessBroker
  signal: AbortSignal
  deadline: number
}): Promise<ManagedJobResult> {
  throwIfAborted(input.signal)
  if (Date.now() >= input.deadline) throw new Error('Python runtime preparation timed out.')
  const jobToken = token()
  const logPath = join(input.paths.rootPath, `.bootstrap-${jobToken}.log`)
  let job: ProcessJob | undefined
  let jobSettled = false
  let jobCancellationRequested = false
  let stdout = ''
  let stderr = ''
  const handleOutput = (batch: ProcessOutputBatch): void => {
    for (const chunk of batch.chunks) {
      if (chunk.stream === 'stdout') stdout = appendBounded(stdout, chunk.text)
      else stderr = appendBounded(stderr, chunk.text)
    }
  }
  const cancelJob = (): void => {
    if (!job || jobCancellationRequested) return
    jobCancellationRequested = true
    job.cancel()
  }
  const abort = (): void => cancelJob()
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    job = await input.processBroker.startJob({
      id: `py-repl-bootstrap-${randomUUID()}`,
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      env: { ...input.env },
      logPath,
      timeoutSeconds: remainingSeconds(input.deadline),
      keepRunningOnTimeout: false,
      retainLog: false,
      spillThresholdChars: MANAGED_PYTHON_JOB_OUTPUT_LIMIT_CHARS
    })
    job.onOutput(handleOutput)
    if (process.platform !== 'win32') {
      await chmod(logPath, 0o600).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error
      })
    }
    if (input.signal.aborted) cancelJob()
    const result = await job.wait()
    jobSettled = true
    throwIfAborted(input.signal)
    if (result.timedOut) throw new Error('Python runtime preparation timed out.')
    return { stdout, stderr, result }
  } finally {
    input.signal.removeEventListener('abort', abort)
    if (job && !jobSettled) {
      cancelJob()
      await job.wait().catch(() => undefined)
    }
    await rm(logPath, { force: true }).catch(() => undefined)
  }
}

async function verifyStagedUv(path: string, expectedSha256: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink()) return false
    if ((await hashFile(path)) !== expectedSha256) return false
    if (process.platform !== 'win32') await chmod(path, 0o700)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ELOOP')) return false
    throw error
  }
}

async function stageUvExecutable(
  paths: ManagedPythonBootstrapPaths,
  compressedBytes: Buffer,
  attestation: UvAssetAttestation
): Promise<string> {
  const executableBytes = await gunzipAsync(compressedBytes)
  if (executableBytes.byteLength > UV_EXECUTABLE_MAX_BYTES) {
    throw new Error('Bundled uv runtime expands beyond its allowed size.')
  }
  const extension = process.platform === 'win32' ? '.exe' : ''
  const targetPath = join(
    paths.toolsPath,
    `uv-${PY_REPL_UV_VERSION}-${attestation.targetTriple}-${attestation.outputSha256.slice(0, 16)}${extension}`
  )
  if (await verifyStagedUv(targetPath, attestation.outputSha256)) return targetPath

  await assertManagedDirectory(paths.toolsPath, paths.homePath)
  const temporaryPath = join(paths.toolsPath, `.uv-${token()}.tmp`)
  await writeFile(temporaryPath, executableBytes, { flag: 'wx', mode: 0o700 })
  try {
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o700)
    if ((await hashFile(temporaryPath)) !== attestation.outputSha256) {
      throw new Error('Bundled uv runtime did not preserve its attested bytes.')
    }
    try {
      await rename(temporaryPath, targetPath)
    } catch (error) {
      if (process.platform !== 'win32') throw error
      if (await verifyStagedUv(targetPath, attestation.outputSha256)) return targetPath
      try {
        const existing = await lstat(targetPath)
        if (!existing.isFile() && !existing.isSymbolicLink()) {
          throw new Error(`Managed uv target is not a replaceable file: ${targetPath}`)
        }
        await unlink(targetPath)
      } catch (targetError) {
        if (!isNodeError(targetError, 'ENOENT')) throw targetError
      }
      await rename(temporaryPath, targetPath)
    }
    if (!(await verifyStagedUv(targetPath, attestation.outputSha256))) {
      throw new Error('Managed uv runtime failed verification after staging.')
    }
    return targetPath
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function resolveAttestedUv(
  options: ManagedPythonResourceOptions,
  paths: ManagedPythonBootstrapPaths
): Promise<string> {
  const name = process.platform === 'win32' ? 'uv.exe' : 'uv'
  const targetTriple = TARGET_TRIPLES[process.platform]?.[process.arch]
  if (!targetTriple) throw bundledUvError(options, 'resources-unavailable')
  const resourceOptions = {
    projectRoot: options.projectRoot,
    resourcesPath: options.resourcesPath,
    startDir: import.meta.dirname
  }
  const archivePath = resolveBundledResource({
    ...resourceOptions,
    name: `${name}${UV_RUNTIME_ARCHIVE_SUFFIX}`
  })
  const attestationPath = resolveBundledResource({
    ...resourceOptions,
    name: `${name}.asset.json`
  })
  if (
    !archivePath ||
    !attestationPath ||
    !isAbsolute(archivePath) ||
    !isAbsolute(attestationPath)
  ) {
    throw bundledUvError(options, 'resources-unavailable')
  }
  try {
    const [archiveStat, attestationStat] = await Promise.all([
      lstat(archivePath),
      lstat(attestationPath)
    ])
    if (
      !archiveStat.isFile() ||
      archiveStat.isSymbolicLink() ||
      archiveStat.size > UV_RUNTIME_ARCHIVE_MAX_BYTES ||
      !attestationStat.isFile() ||
      attestationStat.isSymbolicLink()
    ) {
      throw new Error('Bundled uv resource files are invalid.')
    }
    const attestation = parseAttestation(await readBoundedFile(attestationPath, 16 * 1024))
    if (
      attestation.name !== 'uv' ||
      attestation.version !== PY_REPL_UV_VERSION ||
      attestation.platform !== process.platform ||
      attestation.arch !== process.arch ||
      attestation.targetTriple !== targetTriple ||
      !SHA256_PATTERN.test(attestation.archiveSha256) ||
      !SHA256_PATTERN.test(attestation.outputSha256) ||
      !SHA256_PATTERN.test(attestation.runtimeArchiveSha256) ||
      (await hashFile(archivePath)) !== attestation.runtimeArchiveSha256
    ) {
      throw new Error('Bundled uv runtime attestation does not match its resource.')
    }
    const compressedBytes = await readFile(archivePath)
    if (compressedBytes.byteLength > UV_RUNTIME_ARCHIVE_MAX_BYTES) {
      throw new Error('Bundled uv runtime archive is too large.')
    }
    return await stageUvExecutable(paths, compressedBytes, attestation)
  } catch (error) {
    if (error instanceof ManagedPythonEnvironmentError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw bundledUvError(options, 'resources-invalid', error)
  }
}

export function commandFailure(name: string, job: ManagedJobResult): Error {
  const diagnostics = (
    job.stderr.trim() ||
    job.stdout.trim() ||
    `exit status ${job.result.exitCode}`
  ).slice(-MANAGED_PYTHON_JOB_OUTPUT_LIMIT_CHARS)
  return new Error(`${name} failed with exit status ${job.result.exitCode}: ${diagnostics}`)
}

export async function attestUvExecutable(
  preparation: ManagedPythonUvPreparation,
  signal: AbortSignal,
  deadline: number
): Promise<void> {
  try {
    const probe = await runManagedJob({
      executable: preparation.uvPath,
      args: ['self', 'version', '--output-format', 'json'],
      cwd: preparation.paths.rootPath,
      env: preparation.bootstrapEnv,
      paths: preparation.paths,
      processBroker: preparation.processBroker,
      signal,
      deadline
    })
    if (probe.result.exitCode !== 0) throw commandFailure('uv self version', probe)
    const version = parseStrictObject(probe.stdout.trim())
    const targetTriple = TARGET_TRIPLES[process.platform]?.[process.arch]
    if (
      version['package_name'] !== 'uv' ||
      version['version'] !== PY_REPL_UV_VERSION ||
      version['target_triple'] !== targetTriple
    ) {
      throw new Error('invalid uv')
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new ManagedPythonEnvironmentError(
      'The staged uv runtime failed its version and target attestation.',
      'resources-invalid',
      'preparing-helper',
      { cause: error }
    )
  }
}
