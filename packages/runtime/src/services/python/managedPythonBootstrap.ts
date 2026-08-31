import { randomUUID } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ProcessBroker,
  ProcessJob,
  ProcessJobResult,
  ProcessOutputBatch
} from '../processBroker/processBroker.ts'
import { PY_REPL_UV_VERSION } from './managedPythonConstants.ts'
import { ManagedPythonEnvironmentError } from './managedPythonEnvironmentState.ts'
import { isNodeError, token } from './managedPythonFilesystem.ts'
import { parseStrictObject } from './managedPythonMetadata.ts'
import { getUvReleaseAsset } from './managedUvRuntime.ts'

export const MANAGED_PYTHON_JOB_OUTPUT_LIMIT_CHARS = 64_000

export interface ManagedPythonBootstrapPaths {
  homePath: string
  rootPath: string
  toolsPath: string
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

export function abortError(): Error {
  const error = new Error('The Yachiyo Python runtime preparation was aborted.')
  error.name = 'AbortError'
  return error
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
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
    const targetTriple = getUvReleaseAsset()?.targetTriple
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
      'The managed uv runtime failed its version and target attestation.',
      'resources-invalid',
      'preparing-helper',
      { cause: error }
    )
  }
}
