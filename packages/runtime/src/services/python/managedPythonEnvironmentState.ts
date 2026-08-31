import type {
  ManagedPythonEnvironmentAction,
  ManagedPythonEnvironmentFailure,
  ManagedPythonEnvironmentFailureCode,
  ManagedPythonEnvironmentPhase,
  ManagedPythonEnvironmentStatus
} from '@yachiyo/shared/protocol'

import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { PY_REPL_PYTHON_VERSION, PY_REPL_UV_VERSION } from './managedPythonConstants.ts'
import {
  assertManagedDirectory,
  isNodeError,
  readBoundedFile,
  token,
  writePrivateFile
} from './managedPythonFilesystem.ts'
import { parseStrictObject } from './managedPythonMetadata.ts'

const STATUS_ERROR_LIMIT_CHARS = 8_000
const ENVIRONMENT_ACTIONS = new Set<ManagedPythonEnvironmentAction>([
  'install',
  'repair',
  'rebuild',
  'remove'
])
const ENVIRONMENT_PHASES = new Set<ManagedPythonEnvironmentPhase>([
  'checking',
  'preparing-helper',
  'installing-python',
  'creating-environment',
  'installing-packages',
  'verifying-environment',
  'removing-environment'
])
const ENVIRONMENT_FAILURE_CODES = new Set<ManagedPythonEnvironmentFailureCode>([
  'resources-unavailable',
  'resources-invalid',
  'network',
  'permission',
  'environment',
  'busy',
  'cancelled',
  'unknown'
])

export interface ManagedPythonEnvironmentStatePaths {
  homePath: string
  rootPath: string
  environmentPath: string
  statusPath: string
}

export interface ManagedPythonLeaseSummary {
  blocked: boolean
  activeProcessCount: number
}

const environmentStatusListeners = new Set<(status: ManagedPythonEnvironmentStatus) => void>()
const activeEnvironmentStatuses = new Map<string, ManagedPythonEnvironmentStatus>()

export class ManagedPythonEnvironmentError extends Error {
  readonly code: ManagedPythonEnvironmentFailureCode
  readonly phase: ManagedPythonEnvironmentPhase

  constructor(
    message: string,
    code: ManagedPythonEnvironmentFailureCode,
    phase: ManagedPythonEnvironmentPhase,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ManagedPythonEnvironmentError'
    this.code = code
    this.phase = phase
  }
}

function parsePersistedFailure(value: unknown): ManagedPythonEnvironmentFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const failure = value as Record<string, unknown>
  if (
    typeof failure['code'] !== 'string' ||
    !ENVIRONMENT_FAILURE_CODES.has(failure['code'] as ManagedPythonEnvironmentFailureCode) ||
    typeof failure['message'] !== 'string' ||
    typeof failure['action'] !== 'string' ||
    !ENVIRONMENT_ACTIONS.has(failure['action'] as ManagedPythonEnvironmentAction) ||
    typeof failure['phase'] !== 'string' ||
    !ENVIRONMENT_PHASES.has(failure['phase'] as ManagedPythonEnvironmentPhase) ||
    typeof failure['occurredAt'] !== 'string'
  ) {
    return undefined
  }
  return failure as unknown as ManagedPythonEnvironmentFailure
}

export async function readPersistedFailure(
  paths: ManagedPythonEnvironmentStatePaths
): Promise<ManagedPythonEnvironmentFailure | undefined> {
  try {
    const parsed = parseStrictObject(await readBoundedFile(paths.statusPath, 32 * 1024))
    return parsePersistedFailure(parsed['lastFailure'])
  } catch {
    return undefined
  }
}

function redactFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(https?:\/\/)[^\s/@]+@/giu, '$1***@').slice(0, STATUS_ERROR_LIMIT_CHARS)
}

export function classifyEnvironmentFailure(
  error: unknown,
  action: ManagedPythonEnvironmentAction,
  phase: ManagedPythonEnvironmentPhase
): ManagedPythonEnvironmentFailure {
  let code: ManagedPythonEnvironmentFailureCode = 'unknown'
  let failurePhase = phase
  if (error instanceof ManagedPythonEnvironmentError) {
    code = error.code
    failurePhase = error.phase
  } else if (error instanceof Error && error.name === 'AbortError') {
    code = 'cancelled'
  } else if (
    isNodeError(error, 'EACCES') ||
    isNodeError(error, 'EPERM') ||
    isNodeError(error, 'EROFS')
  ) {
    code = 'permission'
  } else if (
    /\b(?:network|dns|timed? out|connection|certificate|proxy|http \d{3})\b/iu.test(
      redactFailureMessage(error)
    )
  ) {
    code = 'network'
  } else if (phase !== 'checking') {
    code = 'environment'
  }
  return {
    code,
    message: redactFailureMessage(error),
    action,
    phase: failurePhase,
    occurredAt: new Date().toISOString()
  }
}

async function persistEnvironmentStatus(
  paths: ManagedPythonEnvironmentStatePaths,
  status: ManagedPythonEnvironmentStatus
): Promise<void> {
  await assertManagedDirectory(paths.rootPath, paths.homePath)
  const temporaryPath = join(paths.rootPath, `.status-${token()}.tmp`)
  await writePrivateFile(temporaryPath, JSON.stringify(status))
  try {
    try {
      await rename(temporaryPath, paths.statusPath)
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'EPERM'))
      ) {
        throw error
      }
      await rm(paths.statusPath, { force: true })
      await rename(temporaryPath, paths.statusPath)
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function publishEnvironmentStatus(
  paths: ManagedPythonEnvironmentStatePaths,
  status: ManagedPythonEnvironmentStatus
): Promise<ManagedPythonEnvironmentStatus> {
  if (status.operation) activeEnvironmentStatuses.set(paths.rootPath, status)
  else activeEnvironmentStatuses.delete(paths.rootPath)
  await persistEnvironmentStatus(paths, status)
  for (const listener of environmentStatusListeners) {
    try {
      listener(status)
    } catch (error) {
      console.error('[yachiyo][python] Environment status listener failed:', error)
    }
  }
  return status
}

export function createEnvironmentStatus(
  paths: ManagedPythonEnvironmentStatePaths,
  state: ManagedPythonEnvironmentStatus['state'],
  leases: ManagedPythonLeaseSummary,
  input?: {
    operation?: ManagedPythonEnvironmentAction
    phase?: ManagedPythonEnvironmentPhase
    lastFailure?: ManagedPythonEnvironmentFailure
  }
): ManagedPythonEnvironmentStatus {
  return {
    state,
    ...(input?.operation ? { operation: input.operation } : {}),
    ...(input?.phase ? { phase: input.phase } : {}),
    rootPath: paths.rootPath,
    environmentPath: paths.environmentPath,
    pythonVersion: PY_REPL_PYTHON_VERSION,
    uvVersion: PY_REPL_UV_VERSION,
    activeProcessCount: leases.activeProcessCount,
    managementBlocked: leases.blocked,
    updatedAt: new Date().toISOString(),
    ...(input?.lastFailure ? { lastFailure: input.lastFailure } : {})
  }
}

export function getActiveEnvironmentStatus(
  rootPath: string
): ManagedPythonEnvironmentStatus | undefined {
  return activeEnvironmentStatuses.get(rootPath)
}

export function subscribeManagedPythonEnvironmentStatus(
  listener: (status: ManagedPythonEnvironmentStatus) => void
): () => void {
  environmentStatusListeners.add(listener)
  return () => {
    environmentStatusListeners.delete(listener)
  }
}
