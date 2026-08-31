import type {
  ManagedPythonEnvironmentAction,
  ManagedPythonEnvironmentPhase,
  ManagedPythonEnvironmentStatus
} from '@yachiyo/shared/protocol'

import { constants } from 'node:fs'
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  unlink
} from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { resolveYachiyoDataDir, resolveYachiyoPythonRoot } from '../../config/paths.ts'
import type { ProcessBroker } from '../processBroker/processBroker.ts'
import {
  resolveWorkspacePythonEnvironment,
  type WorkspacePythonEnvironment
} from './workspacePythonEnvironment.ts'
import {
  assertManagedDirectory,
  assertOptionalManagedDirectory,
  canonicalForComparison,
  ensureManagedDirectory,
  isNodeError,
  isPathInside,
  readBoundedFile,
  token,
  writePrivateFile
} from './managedPythonFilesystem.ts'
import {
  abortError,
  attestUvExecutable,
  commandFailure,
  MANAGED_PYTHON_JOB_OUTPUT_LIMIT_CHARS as JOB_OUTPUT_LIMIT_CHARS,
  runManagedJob,
  throwIfAborted
} from './managedPythonBootstrap.ts'
import {
  PY_REPL_ENV_SCHEMA_VERSION,
  PY_REPL_PREINSTALLED_PACKAGES,
  PY_REPL_PYTHON_VERSION,
  PY_REPL_UV_VERSION
} from './managedPythonConstants.ts'
import {
  classifyEnvironmentFailure,
  createEnvironmentStatus,
  getActiveEnvironmentStatus,
  ManagedPythonEnvironmentError,
  publishEnvironmentStatus,
  readPersistedFailure
} from './managedPythonEnvironmentState.ts'
import { hasExactKeys, parseStrictObject } from './managedPythonMetadata.ts'
import { resolveDownloadedUv } from './managedUvRuntime.ts'

export { stagePythonRunner } from './managedPythonFilesystem.ts'

export {
  PY_REPL_ENV_SCHEMA_VERSION,
  PY_REPL_PREINSTALLED_PACKAGES,
  PY_REPL_PYTHON_VERSION,
  PY_REPL_UV_VERSION
} from './managedPythonConstants.ts'
export { subscribeManagedPythonEnvironmentStatus } from './managedPythonEnvironmentState.ts'

// Keep the existing path stable so marker upgrades can repair environments in place.
const RUNTIME_DIRECTORY_NAME = 'py-repl-cpython-3.12.14-uv-0.12.7-v2'
const PREINSTALLED_PACKAGE_REQUIREMENTS = Object.entries(PY_REPL_PREINSTALLED_PACKAGES).map(
  ([name, version]) => `${name}==${version}`
)
const PREPARATION_TIMEOUT_MS = 10 * 60 * 1000
const LOCK_POLL_INTERVAL_MS = 250
const TOKEN_PATTERN = /^[a-f0-9]{32}$/u
const LOCK_FILE_PATTERN = /^\.provision-(\d+)-([a-f0-9]{32})\.lock$/u
const LEASE_FILE_PATTERN = /^(\d+)-([a-f0-9]{32})\.json$/u
const PROVISION_LOCK_FILE_NAME = 'provision.lock'
const READY_FILE_NAME = 'ready.json'
const STATUS_FILE_NAME = 'status.json'
const LEASES_DIRECTORY_NAME = 'leases'

const HEALTH_PROBE = [
  'from importlib import metadata',
  'import importlib.util, json, os, sys',
  `expected_packages = ${JSON.stringify(PY_REPL_PREINSTALLED_PACKAGES)}`,
  "spec = importlib.util.find_spec('pip')",
  'origin = None if spec is None or not spec.origin else os.path.realpath(spec.origin)',
  'print(json.dumps({',
  "  'version': '.'.join(str(value) for value in sys.version_info[:3]),",
  "  'prefix': os.path.realpath(sys.prefix),",
  "  'basePrefix': os.path.realpath(sys.base_prefix),",
  "  'pipOrigin': origin,",
  "  'packages': {name: metadata.version(name) for name in expected_packages},",
  "}, allow_nan=False, separators=(',', ':')))"
].join('\n')

const BYTECODE_COMPILE_SCRIPT = [
  'import compileall, sysconfig',
  "site_packages = sysconfig.get_path('purelib')",
  'if not compileall.compile_dir(site_packages, quiet=1):',
  "  raise RuntimeError('Managed Python bytecode compilation failed')"
].join('\n')

const SCIPY_WARMUP_SCRIPT = [
  'from scipy import stats',
  'stats.pearsonr((1.0, 2.0, 3.0), (1.0, 2.0, 3.0))'
].join('\n')

const WORKSPACE_HEALTH_PROBE = [
  'import json, os, sys',
  'print(json.dumps({',
  "  'implementation': sys.implementation.name,",
  "  'version': '.'.join(str(value) for value in sys.version_info[:3]),",
  "  'prefix': os.path.realpath(sys.prefix),",
  "  'basePrefix': os.path.realpath(sys.base_prefix),",
  "}, allow_nan=False, separators=(',', ':')))"
].join('\n')
const WORKSPACE_PROBE_TIMEOUT_MS = 30_000
const PYTHON_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u

interface RuntimePaths {
  homePath: string
  rootPath: string
  cachePath: string
  installationsPath: string
  installationPath: string
  environmentsPath: string
  environmentPath: string
  runnersPath: string
  toolsPath: string
  pythonPath: string
  markerPath: string
  statusPath: string
  leasesPath: string
  provisionLockPath: string
}

interface RuntimePreparation {
  paths: RuntimePaths
  uvPath: string
  bootstrapEnv: Readonly<NodeJS.ProcessEnv>
  kernelEnv: Readonly<NodeJS.ProcessEnv>
  processBroker: ProcessBroker
}

type ManagedRuntimeResetMode = 'none' | 'environment' | 'installation'

interface RuntimeLeaseRecord {
  pid: number
  token: string
  startedAt: number
}

interface ReadyMarker {
  schemaVersion: number
  pythonVersion: string
  uvVersion: string
  installationPath: string
  environmentPath: string
}

interface HealthProbe {
  version: string
  prefix: string
  basePrefix: string
  pipOrigin: string | null
  packages: Record<string, string>
}

interface WorkspaceHealthProbe {
  implementation: string
  version: string
  prefix: string
  basePrefix: string
}

interface PreparationEntry {
  controller: AbortController
  promise: Promise<RuntimePreparation>
  waiters: number
  settled: boolean
}

export type PythonRuntimeKind = 'managed' | 'workspace'

export interface PythonRuntime {
  kind: PythonRuntimeKind
  rootPath: string
  pythonPath: string
  uvPath: string
  environmentPath: string
  env: Readonly<NodeJS.ProcessEnv>
  version: string
  acquireProcessLease(pid: number, signal?: AbortSignal): Promise<() => Promise<void>>
  release(): Promise<void>
}

export interface EnsureManagedPythonRuntimeOptions {
  processBroker: ProcessBroker
  signal?: AbortSignal
  yachiyoHome?: string
}

export interface EnsurePythonRuntimeOptions extends EnsureManagedPythonRuntimeOptions {
  workspacePath: string
}

const preparations = new Map<string, PreparationEntry>()
const environmentManagementOperations = new Map<string, Promise<ManagedPythonEnvironmentStatus>>()

async function createRuntimePaths(yachiyoHome?: string): Promise<RuntimePaths> {
  const requestedHome = yachiyoHome ?? resolveYachiyoDataDir()
  await mkdir(requestedHome, { recursive: true })
  const homePath = await realpath(requestedHome)
  const rootPath = resolveYachiyoPythonRoot(homePath)
  const cachePath = join(rootPath, 'cache')
  const installationsPath = join(rootPath, 'installations')
  const installationPath = join(installationsPath, RUNTIME_DIRECTORY_NAME)
  const environmentsPath = join(rootPath, 'environments')
  const environmentPath = join(environmentsPath, RUNTIME_DIRECTORY_NAME)
  const runnersPath = join(rootPath, 'runners')
  const toolsPath = join(rootPath, 'tools')

  for (const path of [
    rootPath,
    cachePath,
    installationsPath,
    environmentsPath,
    runnersPath,
    toolsPath
  ]) {
    await ensureManagedDirectory(path, homePath)
  }
  if (await assertOptionalManagedDirectory(installationPath, homePath)) {
    if (process.platform !== 'win32') {
      await assertManagedDirectory(installationPath, homePath)
      await chmod(installationPath, 0o700)
    }
  }
  if (await assertOptionalManagedDirectory(environmentPath, homePath)) {
    if (process.platform !== 'win32') {
      await assertManagedDirectory(environmentPath, homePath)
      await chmod(environmentPath, 0o700)
    }
  }

  return {
    homePath,
    rootPath,
    cachePath,
    installationsPath,
    installationPath,
    environmentsPath,
    environmentPath,
    runnersPath,
    toolsPath,
    pythonPath:
      process.platform === 'win32'
        ? join(environmentPath, 'Scripts', 'python.exe')
        : join(environmentPath, 'bin', 'python'),
    markerPath: join(environmentPath, READY_FILE_NAME),
    statusPath: join(rootPath, STATUS_FILE_NAME),
    leasesPath: join(environmentPath, LEASES_DIRECTORY_NAME),
    provisionLockPath: join(rootPath, PROVISION_LOCK_FILE_NAME)
  }
}

const ALLOWED_ENVIRONMENT_NAMES: Readonly<Record<string, true>> = {
  PATH: true,
  HOME: true,
  USER: true,
  LOGNAME: true,
  USERPROFILE: true,
  USERNAME: true,
  HOMEDRIVE: true,
  HOMEPATH: true,
  SYSTEMROOT: true,
  WINDIR: true,
  COMSPEC: true,
  PATHEXT: true,
  TEMP: true,
  TMP: true,
  TMPDIR: true,
  TZ: true,
  LANG: true,
  LANGUAGE: true,
  HTTP_PROXY: true,
  HTTPS_PROXY: true,
  ALL_PROXY: true,
  NO_PROXY: true,
  http_proxy: true,
  https_proxy: true,
  all_proxy: true,
  no_proxy: true,
  SSL_CERT_FILE: true,
  SSL_CERT_DIR: true,
  CURL_CA_BUNDLE: true,
  REQUESTS_CA_BUNDLE: true
}

function buildAllowedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const windowsAllowedNames: Readonly<Record<string, true>> =
    process.platform === 'win32'
      ? Object.fromEntries(
          Object.keys(ALLOWED_ENVIRONMENT_NAMES).map((name) => [name.toUpperCase(), true] as const)
        )
      : {}
  const result: NodeJS.ProcessEnv = {}
  const emittedWindowsNames = new Set<string>()
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const allowed = ALLOWED_ENVIRONMENT_NAMES[name] === true || /^LC_[A-Z0-9_]+$/u.test(name)
    const windowsCanonical = name.toUpperCase()
    const windowsAllowed =
      process.platform === 'win32' &&
      (windowsAllowedNames[windowsCanonical] === true || /^LC_[A-Z0-9_]+$/u.test(windowsCanonical))
    if (!allowed && !windowsAllowed) continue
    if (process.platform === 'win32') {
      if (emittedWindowsNames.has(windowsCanonical)) continue
      emittedWindowsNames.add(windowsCanonical)
      result[windowsCanonical] = value
    } else {
      result[name] = value
    }
  }
  return result
}

function buildRuntimeEnvironments(
  paths: RuntimePaths,
  environmentPath = paths.environmentPath,
  managedPython = true
): {
  bootstrapEnv: Readonly<NodeJS.ProcessEnv>
  kernelEnv: Readonly<NodeJS.ProcessEnv>
} {
  const allowed = buildAllowedEnvironment(process.env)
  const bootstrapEnv: NodeJS.ProcessEnv = {
    ...allowed,
    UV_CACHE_DIR: paths.cachePath,
    UV_PYTHON_INSTALL_DIR: paths.installationPath,
    UV_MANAGED_PYTHON: '1',
    UV_NO_CONFIG: '1',
    UV_NO_PROGRESS: '1'
  }
  const executableDirectory =
    process.platform === 'win32' ? join(environmentPath, 'Scripts') : join(environmentPath, 'bin')
  const inheritedPath = bootstrapEnv['PATH']?.trim()
  const kernelEnv: NodeJS.ProcessEnv = {
    ...bootstrapEnv,
    PATH: inheritedPath
      ? `${executableDirectory}${delimiter}${inheritedPath}`
      : executableDirectory,
    VIRTUAL_ENV: environmentPath,
    PYTHONNOUSERSITE: '1',
    PYTHONSAFEPATH: '1',
    PIP_REQUIRE_VIRTUALENV: '1'
  }
  if (!managedPython) delete kernelEnv['UV_MANAGED_PYTHON']
  return { bootstrapEnv: Object.freeze(bootstrapEnv), kernelEnv: Object.freeze(kernelEnv) }
}

function hasPreinstalledPackages(value: unknown, requirePinnedVersions: boolean): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const packages = value as Record<string, unknown>
  const expected = Object.entries(PY_REPL_PREINSTALLED_PACKAGES)
  return (
    hasExactKeys(
      packages,
      expected.map(([name]) => name)
    ) &&
    expected.every(([name, version]) => {
      const installedVersion = packages[name]
      return (
        typeof installedVersion === 'string' &&
        installedVersion.length > 0 &&
        (!requirePinnedVersions || installedVersion === version)
      )
    })
  )
}

function parseLeaseRecord(value: string): RuntimeLeaseRecord {
  const parsed = parseStrictObject(value)
  if (
    !hasExactKeys(parsed, ['pid', 'token', 'startedAt']) ||
    !Number.isSafeInteger(parsed['pid']) ||
    (parsed['pid'] as number) <= 0 ||
    typeof parsed['token'] !== 'string' ||
    !TOKEN_PATTERN.test(parsed['token']) ||
    !Number.isSafeInteger(parsed['startedAt']) ||
    (parsed['startedAt'] as number) < 0
  ) {
    throw new Error('Managed Python lease metadata is invalid.')
  }
  return {
    pid: parsed['pid'] as number,
    token: parsed['token'],
    startedAt: parsed['startedAt'] as number
  }
}

function processLiveness(pid: number): 'live' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    if (isNodeError(error, 'ESRCH')) return 'dead'
    if (isNodeError(error, 'EPERM')) return 'live'
    return 'unknown'
  }
}

async function tokenSafeRemove(path: string, expected: RuntimeLeaseRecord): Promise<boolean> {
  try {
    const current = parseLeaseRecord(await readBoundedFile(path, 4096))
    if (current.pid !== expected.pid || current.token !== expected.token) return false
    await unlink(path)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true
    return false
  }
}

function encodeRecord(record: RuntimeLeaseRecord): string {
  return JSON.stringify(record)
}

async function scanLeases(
  paths: RuntimePaths
): Promise<{ blocked: boolean; activeProcessCount: number }> {
  if (!(await assertOptionalManagedDirectory(paths.leasesPath, paths.homePath))) {
    return { blocked: false, activeProcessCount: 0 }
  }
  let blocked = false
  let activeProcessCount = 0
  for (const name of await readdir(paths.leasesPath)) {
    const match = LEASE_FILE_PATTERN.exec(name)
    if (!match) {
      blocked = true
      continue
    }
    const path = join(paths.leasesPath, name)
    try {
      const record = parseLeaseRecord(await readBoundedFile(path, 4096))
      if (record.pid !== Number(match[1]) || record.token !== match[2]) {
        blocked = true
        continue
      }
      const liveness = processLiveness(record.pid)
      if (liveness === 'dead') {
        await tokenSafeRemove(path, record)
      } else {
        blocked = true
        activeProcessCount += 1
      }
    } catch {
      blocked = true
    }
  }
  return { blocked, activeProcessCount }
}

function parseReadyMarker(value: string): ReadyMarker {
  const parsed = parseStrictObject(value)
  if (
    !hasExactKeys(parsed, [
      'schemaVersion',
      'pythonVersion',
      'uvVersion',
      'installationPath',
      'environmentPath'
    ]) ||
    !Number.isSafeInteger(parsed['schemaVersion']) ||
    typeof parsed['pythonVersion'] !== 'string' ||
    typeof parsed['uvVersion'] !== 'string' ||
    typeof parsed['installationPath'] !== 'string' ||
    typeof parsed['environmentPath'] !== 'string'
  ) {
    throw new Error('Managed Python readiness marker is invalid.')
  }
  return parsed as unknown as ReadyMarker
}

async function expectedReadyMarker(paths: RuntimePaths): Promise<ReadyMarker> {
  return {
    schemaVersion: PY_REPL_ENV_SCHEMA_VERSION,
    pythonVersion: PY_REPL_PYTHON_VERSION,
    uvVersion: PY_REPL_UV_VERSION,
    installationPath: await realpath(paths.installationPath),
    environmentPath: await realpath(paths.environmentPath)
  }
}

function samePath(first: string, second: string): boolean {
  return canonicalForComparison(first) === canonicalForComparison(second)
}

async function runHealthProbe(
  preparation: Pick<RuntimePreparation, 'paths' | 'processBroker' | 'bootstrapEnv'>,
  signal: AbortSignal,
  deadline: number,
  requirePip: boolean,
  requirePinnedPackageVersions = false
): Promise<boolean> {
  const { paths } = preparation
  try {
    await assertManagedDirectory(paths.environmentPath, paths.homePath)
    await access(paths.pythonPath, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
    const probeResult = await runManagedJob({
      executable: paths.pythonPath,
      args: ['-I', '-c', HEALTH_PROBE],
      cwd: paths.rootPath,
      env: preparation.bootstrapEnv,
      paths,
      processBroker: preparation.processBroker,
      signal,
      deadline
    })
    if (probeResult.result.exitCode !== 0 || probeResult.stderr.trim()) return false
    const parsed = parseStrictObject(probeResult.stdout.trim())
    if (
      !hasExactKeys(parsed, ['version', 'prefix', 'basePrefix', 'pipOrigin', 'packages']) ||
      typeof parsed['version'] !== 'string' ||
      typeof parsed['prefix'] !== 'string' ||
      typeof parsed['basePrefix'] !== 'string' ||
      (parsed['pipOrigin'] !== null && typeof parsed['pipOrigin'] !== 'string') ||
      !hasPreinstalledPackages(parsed['packages'], requirePinnedPackageVersions)
    ) {
      return false
    }
    const probe = parsed as unknown as HealthProbe
    const environmentPath = await realpath(paths.environmentPath)
    const installationPath = await realpath(paths.installationPath)
    if (
      probe.version !== PY_REPL_PYTHON_VERSION ||
      !samePath(probe.prefix, environmentPath) ||
      samePath(probe.basePrefix, probe.prefix) ||
      !isPathInside(installationPath, probe.basePrefix)
    ) {
      return false
    }
    if (requirePip && probe.pipOrigin === null) return false
    return probe.pipOrigin === null || isPathInside(environmentPath, probe.pipOrigin)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return false
  }
}

async function compileEnvironmentBytecode(
  preparation: Pick<RuntimePreparation, 'paths' | 'processBroker' | 'bootstrapEnv'>,
  signal: AbortSignal,
  deadline: number
): Promise<void> {
  const { paths } = preparation
  const compilation = await runManagedJob({
    executable: paths.pythonPath,
    args: ['-I', '-c', BYTECODE_COMPILE_SCRIPT],
    cwd: paths.rootPath,
    env: preparation.bootstrapEnv,
    paths,
    processBroker: preparation.processBroker,
    signal,
    deadline
  })
  if (compilation.result.exitCode !== 0) {
    throw commandFailure('Managed Python bytecode compilation', compilation)
  }
}

async function warmScipy(
  preparation: Pick<RuntimePreparation, 'paths' | 'processBroker' | 'bootstrapEnv'>,
  signal: AbortSignal,
  deadline: number
): Promise<void> {
  const { paths } = preparation
  const warmup = await runManagedJob({
    executable: paths.pythonPath,
    args: ['-I', '-c', SCIPY_WARMUP_SCRIPT],
    cwd: paths.rootPath,
    env: preparation.bootstrapEnv,
    paths,
    processBroker: preparation.processBroker,
    signal,
    deadline
  })
  if (warmup.result.exitCode !== 0) {
    throw commandFailure('Managed SciPy warmup', warmup)
  }
}

async function markerMatches(paths: RuntimePaths): Promise<boolean> {
  try {
    const actual = parseReadyMarker(await readBoundedFile(paths.markerPath, 16 * 1024))
    const expected = await expectedReadyMarker(paths)
    return (
      actual.schemaVersion === expected.schemaVersion &&
      actual.pythonVersion === expected.pythonVersion &&
      actual.uvVersion === expected.uvVersion &&
      samePath(actual.installationPath, expected.installationPath) &&
      samePath(actual.environmentPath, expected.environmentPath)
    )
  } catch {
    return false
  }
}

async function writeReadyMarker(paths: RuntimePaths): Promise<void> {
  await assertManagedDirectory(paths.environmentPath, paths.homePath)
  const marker = await expectedReadyMarker(paths)
  const temporaryPath = join(paths.environmentPath, `.ready-${token()}.tmp`)
  await writePrivateFile(temporaryPath, JSON.stringify(marker))
  try {
    await assertManagedDirectory(paths.environmentPath, paths.homePath)
    try {
      await rename(temporaryPath, paths.markerPath)
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'EPERM'))
      ) {
        throw error
      }
      await rm(paths.markerPath, { force: true })
      await rename(temporaryPath, paths.markerPath)
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function publishOperationPhase(
  paths: RuntimePaths,
  action: ManagedPythonEnvironmentAction,
  phase: ManagedPythonEnvironmentPhase,
  state: ManagedPythonEnvironmentStatus['state']
): Promise<void> {
  const leases = await scanLeases(paths)
  await publishEnvironmentStatus(
    paths,
    createEnvironmentStatus(paths, state, leases, { operation: action, phase })
  )
}

async function publishOperationFailure(
  paths: RuntimePaths,
  action: ManagedPythonEnvironmentAction,
  phase: ManagedPythonEnvironmentPhase,
  error: unknown,
  stateOverride?: ManagedPythonEnvironmentStatus['state']
): Promise<void> {
  const failure = classifyEnvironmentFailure(error, action, phase)
  const environmentExists = await assertOptionalManagedDirectory(
    paths.environmentPath,
    paths.homePath
  ).catch(() => false)
  const state: ManagedPythonEnvironmentStatus['state'] =
    stateOverride ??
    (failure.code === 'resources-unavailable' || failure.code === 'resources-invalid'
      ? 'unavailable'
      : environmentExists
        ? 'needs-repair'
        : 'not-installed')
  const leases = await scanLeases(paths).catch(() => ({
    blocked: true,
    activeProcessCount: 0
  }))
  console.error(
    `[yachiyo][python] ${action}/${failure.phase} failed (${failure.code}): ${failure.message}`
  )
  await publishEnvironmentStatus(
    paths,
    createEnvironmentStatus(paths, state, leases, { lastFailure: failure })
  )
}

export async function getManagedPythonEnvironmentStatus(
  options: EnsureManagedPythonRuntimeOptions
): Promise<ManagedPythonEnvironmentStatus> {
  const paths = await createRuntimePaths(options.yachiyoHome)
  const active = getActiveEnvironmentStatus(paths.rootPath)
  if (active) return active
  const leases = await scanLeases(paths)
  const lastFailure = await readPersistedFailure(paths)
  const environmentExists = await assertOptionalManagedDirectory(
    paths.environmentPath,
    paths.homePath
  )
  let state: ManagedPythonEnvironmentStatus['state'] = 'not-installed'
  if (environmentExists) {
    const environments = buildRuntimeEnvironments(paths)
    const signal = options.signal ?? new AbortController().signal
    const healthy =
      (await markerMatches(paths)) &&
      (await runHealthProbe(
        {
          paths,
          processBroker: options.processBroker,
          bootstrapEnv: environments.bootstrapEnv
        },
        signal,
        Date.now() + WORKSPACE_PROBE_TIMEOUT_MS,
        false
      ))
    state = healthy ? 'ready' : 'needs-repair'
  } else if (
    lastFailure?.code === 'resources-unavailable' ||
    lastFailure?.code === 'resources-invalid'
  ) {
    state = 'unavailable'
  }
  return await publishEnvironmentStatus(
    paths,
    createEnvironmentStatus(paths, state, leases, { lastFailure })
  )
}

async function cleanupOrphanLocks(paths: RuntimePaths): Promise<void> {
  const fixedIdentity = await lstat(paths.provisionLockPath).catch(() => undefined)
  if (fixedIdentity?.isSymbolicLink() || (fixedIdentity && !fixedIdentity.isFile())) return
  for (const name of await readdir(paths.rootPath)) {
    const match = LOCK_FILE_PATTERN.exec(name)
    if (!match) continue
    const path = join(paths.rootPath, name)
    try {
      const pathIdentity = await lstat(path)
      if (!pathIdentity.isFile() || pathIdentity.isSymbolicLink()) continue
      if (
        fixedIdentity &&
        pathIdentity.dev === fixedIdentity.dev &&
        pathIdentity.ino === fixedIdentity.ino
      ) {
        continue
      }
      const record = parseLeaseRecord(await readBoundedFile(path, 4096))
      if (
        record.pid !== Number(match[1]) ||
        record.token !== match[2] ||
        processLiveness(record.pid) !== 'dead'
      ) {
        continue
      }
      await tokenSafeRemove(path, record)
    } catch {
      // Malformed or unverifiable orphan metadata is intentionally preserved.
    }
  }
}

async function acquireProvisionLock(
  paths: RuntimePaths,
  signal: AbortSignal,
  deadline: number
): Promise<() => Promise<void>> {
  await cleanupOrphanLocks(paths)
  const lockToken = token()
  const record: RuntimeLeaseRecord = { pid: process.pid, token: lockToken, startedAt: Date.now() }
  const uniquePath = join(paths.rootPath, `.provision-${record.pid}-${record.token}.lock`)
  await writePrivateFile(uniquePath, encodeRecord(record), true)
  let ownsLock = false
  try {
    while (!ownsLock) {
      throwIfAborted(signal)
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for another Yachiyo process to prepare Python ${PY_REPL_PYTHON_VERSION}.`
        )
      }
      try {
        await link(uniquePath, paths.provisionLockPath)
        ownsLock = true
        await unlink(uniquePath)
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
        try {
          const owner = parseLeaseRecord(await readBoundedFile(paths.provisionLockPath, 4096))
          if (processLiveness(owner.pid) === 'dead') {
            await tokenSafeRemove(paths.provisionLockPath, owner)
            continue
          }
        } catch {
          // A malformed or unverifiable fixed lock must never be stolen.
        }
        await sleep(LOCK_POLL_INTERVAL_MS, undefined, { signal })
      }
    }
  } catch (error) {
    await rm(uniquePath, { force: true })
    throw error
  }

  let released = false
  return async (): Promise<void> => {
    if (released) return
    released = true
    await tokenSafeRemove(paths.provisionLockPath, record)
  }
}

async function removeManagedEnvironment(paths: RuntimePaths): Promise<void> {
  if (!(await assertOptionalManagedDirectory(paths.environmentPath, paths.homePath))) return
  const leases = await scanLeases(paths)
  if (leases.blocked) {
    throw new ManagedPythonEnvironmentError(
      `Yachiyo Python ${PY_REPL_PYTHON_VERSION} is still in use by another Yachiyo process. Close active Python sessions and retry.`,
      'busy',
      'removing-environment'
    )
  }
  await assertManagedDirectory(paths.environmentPath, paths.homePath)
  await rm(paths.environmentPath, { recursive: true, force: true })
}

async function removeManagedInstallation(paths: RuntimePaths): Promise<void> {
  if (!(await assertOptionalManagedDirectory(paths.installationPath, paths.homePath))) return
  await assertManagedDirectory(paths.installationPath, paths.homePath)
  await rm(paths.installationPath, { recursive: true, force: true })
}

async function assertProvisionAnchors(paths: RuntimePaths): Promise<void> {
  for (const path of [
    paths.rootPath,
    paths.cachePath,
    paths.installationsPath,
    paths.installationPath,
    paths.environmentsPath
  ]) {
    await assertManagedDirectory(path, paths.homePath)
  }
}

async function provisionRuntime(
  preparation: RuntimePreparation,
  signal: AbortSignal,
  deadline: number,
  action: ManagedPythonEnvironmentAction,
  resetMode: ManagedRuntimeResetMode
): Promise<void> {
  const { paths } = preparation
  const releaseLock = await acquireProvisionLock(paths, signal, deadline)
  let replacedEnvironment = false
  try {
    await publishOperationPhase(paths, action, 'checking', 'needs-repair')
    const markerReady = resetMode === 'none' && (await markerMatches(paths))
    const healthy =
      resetMode === 'none' && (await runHealthProbe(preparation, signal, deadline, false))
    if (healthy) {
      await publishOperationPhase(paths, action, 'verifying-environment', 'ready')
      if (!markerReady) {
        await compileEnvironmentBytecode(preparation, signal, deadline)
        await warmScipy(preparation, signal, deadline)
        await writeReadyMarker(paths)
      }
      await ensureManagedDirectory(paths.leasesPath, paths.homePath)
      await scanLeases(paths)
      return
    }

    await publishOperationPhase(paths, action, 'preparing-helper', 'needs-repair')
    await attestUvExecutable(preparation, signal, deadline)
    await publishOperationPhase(paths, action, 'removing-environment', 'needs-repair')
    await removeManagedEnvironment(paths)
    replacedEnvironment = true
    if (resetMode === 'installation') await removeManagedInstallation(paths)

    await publishOperationPhase(paths, action, 'installing-python', 'not-installed')
    await ensureManagedDirectory(paths.installationPath, paths.homePath)
    await assertProvisionAnchors(paths)
    const installationJob = await runManagedJob({
      executable: preparation.uvPath,
      args: [
        '--no-config',
        '--no-progress',
        'python',
        'install',
        ...(action === 'install' || action === 'rebuild' ? ['--reinstall'] : []),
        '--no-bin',
        '--no-registry',
        '--install-dir',
        paths.installationPath,
        PY_REPL_PYTHON_VERSION
      ],
      cwd: paths.rootPath,
      env: preparation.bootstrapEnv,
      paths,
      processBroker: preparation.processBroker,
      signal,
      deadline
    })
    if (installationJob.result.exitCode !== 0) {
      throw commandFailure('uv Python installation', installationJob)
    }

    await publishOperationPhase(paths, action, 'creating-environment', 'not-installed')
    await assertProvisionAnchors(paths)
    await ensureManagedDirectory(paths.environmentPath, paths.homePath)
    const venvJob = await runManagedJob({
      executable: preparation.uvPath,
      args: [
        '--no-config',
        '--no-progress',
        '--no-python-downloads',
        'venv',
        '--no-project',
        '--allow-existing',
        '--managed-python',
        '--python',
        PY_REPL_PYTHON_VERSION,
        '--seed',
        paths.environmentPath
      ],
      cwd: paths.rootPath,
      env: preparation.bootstrapEnv,
      paths,
      processBroker: preparation.processBroker,
      signal,
      deadline
    })
    if (venvJob.result.exitCode !== 0) {
      throw commandFailure('uv virtualenv creation', venvJob)
    }

    await publishOperationPhase(paths, action, 'installing-packages', 'not-installed')
    const packageJob = await runManagedJob({
      executable: preparation.uvPath,
      args: [
        '--no-config',
        '--no-progress',
        '--no-python-downloads',
        'pip',
        'install',
        '--python',
        paths.pythonPath,
        '--only-binary',
        ':all:',
        '--strict',
        '--compile-bytecode',
        ...PREINSTALLED_PACKAGE_REQUIREMENTS
      ],
      cwd: paths.rootPath,
      env: preparation.bootstrapEnv,
      paths,
      processBroker: preparation.processBroker,
      signal,
      deadline
    })
    if (packageJob.result.exitCode !== 0) {
      throw commandFailure('uv scientific package installation', packageJob)
    }

    await publishOperationPhase(paths, action, 'verifying-environment', 'not-installed')
    await warmScipy(preparation, signal, deadline)
    if (!(await runHealthProbe(preparation, signal, deadline, true, true))) {
      throw new Error('The private Python environment failed its isolated health check.')
    }
    await ensureManagedDirectory(paths.leasesPath, paths.homePath)
    await writeReadyMarker(paths)
  } catch (error) {
    if (replacedEnvironment) {
      await removeManagedEnvironment(paths).catch(() => undefined)
    }
    throw error
  } finally {
    await releaseLock()
  }
}

async function prepareRuntime(
  options: EnsureManagedPythonRuntimeOptions,
  paths: RuntimePaths,
  signal: AbortSignal,
  action: ManagedPythonEnvironmentAction,
  resetMode: ManagedRuntimeResetMode
): Promise<RuntimePreparation> {
  const deadline = Date.now() + PREPARATION_TIMEOUT_MS
  try {
    await publishOperationPhase(paths, action, 'checking', 'needs-repair')
    const environments = buildRuntimeEnvironments(paths)
    await publishOperationPhase(paths, action, 'preparing-helper', 'needs-repair')
    const uvPath = await resolveDownloadedUv(paths, signal, deadline)
    const preparation: RuntimePreparation = {
      paths,
      uvPath,
      ...environments,
      processBroker: options.processBroker
    }
    await provisionRuntime(preparation, signal, deadline, action, resetMode)
    if (
      !(await markerMatches(paths)) ||
      !(await runHealthProbe(preparation, signal, deadline, false))
    ) {
      throw new Error('The private Python environment did not remain healthy after preparation.')
    }
    const leases = await scanLeases(paths)
    await publishEnvironmentStatus(paths, createEnvironmentStatus(paths, 'ready', leases))
    return preparation
  } catch (error) {
    const phase = getActiveEnvironmentStatus(paths.rootPath)?.phase ?? 'checking'
    await publishOperationFailure(paths, action, phase, error).catch((statusError: unknown) => {
      console.error('[yachiyo][python] Could not persist environment failure:', statusError)
    })
    throw error
  }
}

function preparationFailure(error: unknown, rootPath: string): Error {
  if (
    error instanceof ManagedPythonEnvironmentError ||
    (error instanceof Error && error.name === 'AbortError')
  ) {
    return error
  }
  if (error instanceof Error && error.message.startsWith('Timed out waiting')) {
    return error
  }
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(
    `Could not prepare Yachiyo Python ${PY_REPL_PYTHON_VERSION} in ${rootPath}: ${reason.slice(-JOB_OUTPUT_LIMIT_CHARS)}. Manage or repair the environment in Settings > Capabilities > Python.`
  )
}

async function waitForPreparation(
  entry: PreparationEntry,
  signal: AbortSignal | undefined
): Promise<RuntimePreparation> {
  throwIfAborted(signal)
  entry.waiters += 1
  let removeAbortListener = (): void => undefined
  const caller = signal
    ? Promise.race([
        entry.promise,
        new Promise<never>((_, reject) => {
          const abort = (): void => reject(abortError())
          removeAbortListener = (): void => signal.removeEventListener('abort', abort)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      ])
    : entry.promise
  try {
    return await caller
  } finally {
    removeAbortListener()
    entry.waiters -= 1
    if (entry.waiters === 0 && !entry.settled) {
      entry.controller.abort()
      await entry.promise.catch(() => undefined)
    }
  }
}

async function acquireLease(
  preparation: RuntimePreparation,
  pid: number,
  signal?: AbortSignal
): Promise<() => Promise<void>> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || processLiveness(pid) !== 'live') {
    throw new Error(`Cannot lease Yachiyo Python to inactive process ${pid}.`)
  }
  const deadline = Date.now() + PREPARATION_TIMEOUT_MS
  const { paths } = preparation
  const leaseSignal = signal ?? new AbortController().signal
  while (true) {
    throwIfAborted(signal)
    if (processLiveness(pid) !== 'live') {
      throw new Error(`Cannot lease Yachiyo Python to inactive process ${pid}.`)
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for another Yachiyo process to prepare Python ${PY_REPL_PYTHON_VERSION}.`
      )
    }
    if (await assertOptionalManagedDirectory(paths.rootPath, paths.homePath)) {
      try {
        await lstat(paths.provisionLockPath)
        await sleep(LOCK_POLL_INTERVAL_MS, undefined, { signal })
        continue
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
    await ensureManagedDirectory(paths.leasesPath, paths.homePath)
    const leaseToken = token()
    const record: RuntimeLeaseRecord = { pid, token: leaseToken, startedAt: Date.now() }
    const temporaryPath = join(paths.leasesPath, `.${pid}-${leaseToken}.tmp`)
    const leasePath = join(paths.leasesPath, `${pid}-${leaseToken}.json`)
    await writePrivateFile(temporaryPath, encodeRecord(record), true)
    try {
      await rename(temporaryPath, leasePath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
    let leaseOwnershipTransferred = false
    try {
      try {
        await lstat(paths.provisionLockPath)
        continue
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
      if (
        !(await markerMatches(paths)) ||
        !(await runHealthProbe(preparation, leaseSignal, deadline, false))
      ) {
        await tokenSafeRemove(leasePath, record)
        try {
          await provisionRuntime(preparation, leaseSignal, deadline, 'repair', 'none')
          const leases = await scanLeases(paths)
          await publishEnvironmentStatus(paths, createEnvironmentStatus(paths, 'ready', leases))
        } catch (error) {
          const phase = getActiveEnvironmentStatus(paths.rootPath)?.phase ?? 'checking'
          await publishOperationFailure(paths, 'repair', phase, error).catch(() => undefined)
          throw error
        }
        continue
      }
      if (processLiveness(pid) !== 'live') {
        throw new Error(`Cannot lease Yachiyo Python to inactive process ${pid}.`)
      }
      leaseOwnershipTransferred = true
      let released = false
      return async (): Promise<void> => {
        if (released) return
        released = true
        await tokenSafeRemove(leasePath, record)
      }
    } finally {
      if (!leaseOwnershipTransferred) await tokenSafeRemove(leasePath, record)
    }
  }
}

function parseWorkspaceHealthProbe(value: string): WorkspaceHealthProbe {
  const parsed = parseStrictObject(value)
  if (
    !hasExactKeys(parsed, ['implementation', 'version', 'prefix', 'basePrefix']) ||
    typeof parsed['implementation'] !== 'string' ||
    typeof parsed['version'] !== 'string' ||
    typeof parsed['prefix'] !== 'string' ||
    typeof parsed['basePrefix'] !== 'string'
  ) {
    throw new Error('Workspace .venv Python probe returned malformed metadata.')
  }
  return parsed as unknown as WorkspaceHealthProbe
}

function supportsWorkspacePython(probe: WorkspaceHealthProbe): boolean {
  const match = PYTHON_VERSION_PATTERN.exec(probe.version)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return probe.implementation === 'cpython' && major === 3 && minor >= 11
}

async function ensureWorkspacePythonRuntime(
  options: EnsurePythonRuntimeOptions,
  workspace: WorkspacePythonEnvironment
): Promise<PythonRuntime> {
  throwIfAborted(options.signal)
  const signal = options.signal ?? new AbortController().signal
  const paths = await createRuntimePaths(options.yachiyoHome)
  const environments = buildRuntimeEnvironments(paths, workspace.environmentPath, false)
  const probeDeadline = Date.now() + WORKSPACE_PROBE_TIMEOUT_MS
  const probeResult = await runManagedJob({
    executable: workspace.pythonPath,
    args: ['-I', '-c', WORKSPACE_HEALTH_PROBE],
    cwd: workspace.workspacePath,
    env: environments.kernelEnv,
    paths,
    processBroker: options.processBroker,
    signal,
    deadline: probeDeadline
  })
  if (probeResult.result.exitCode !== 0) {
    throw new Error(
      `Workspace .venv Python probe failed with exit code ${String(probeResult.result.exitCode)}. Recreate ${join(workspace.workspacePath, '.venv')} with CPython 3.11 or newer.`
    )
  }

  const probe = parseWorkspaceHealthProbe(probeResult.stdout.trim())
  if (!supportsWorkspacePython(probe)) {
    throw new Error(
      `pyRepl requires CPython 3.11 or newer in workspace .venv; found ${probe.implementation} ${probe.version}.`
    )
  }
  if (!isAbsolute(probe.prefix) || !samePath(probe.prefix, workspace.environmentPath)) {
    throw new Error(
      `Workspace .venv Python resolved to a different environment: ${probe.prefix}. Recreate ${join(workspace.workspacePath, '.venv')}.`
    )
  }
  if (!isAbsolute(probe.basePrefix) || samePath(probe.basePrefix, probe.prefix)) {
    throw new Error(
      `Workspace .venv Python is not a virtual environment. Recreate ${join(workspace.workspacePath, '.venv')} with CPython 3.11 or newer.`
    )
  }

  throwIfAborted(options.signal)
  const uvDeadline = Date.now() + PREPARATION_TIMEOUT_MS
  const uvPath = await resolveDownloadedUv(paths, signal, uvDeadline)
  const preparation: RuntimePreparation = {
    paths,
    uvPath,
    bootstrapEnv: environments.bootstrapEnv,
    kernelEnv: environments.kernelEnv,
    processBroker: options.processBroker
  }
  await attestUvExecutable(preparation, signal, uvDeadline)
  return {
    kind: 'workspace',
    rootPath: paths.rootPath,
    pythonPath: workspace.pythonPath,
    uvPath,
    environmentPath: workspace.environmentPath,
    env: environments.kernelEnv,
    version: probe.version,
    acquireProcessLease: async (_pid, leaseSignal): Promise<() => Promise<void>> => {
      throwIfAborted(leaseSignal)
      return async (): Promise<void> => undefined
    },
    release: async (): Promise<void> => undefined
  }
}

export async function ensurePythonRuntime(
  options: EnsurePythonRuntimeOptions
): Promise<PythonRuntime> {
  throwIfAborted(options.signal)
  const workspace = await resolveWorkspacePythonEnvironment(options.workspacePath)
  if (!workspace) return await ensureManagedPythonRuntime(options)
  return await ensureWorkspacePythonRuntime(options, workspace)
}

async function performRemoveEnvironment(
  options: EnsureManagedPythonRuntimeOptions,
  paths: RuntimePaths
): Promise<ManagedPythonEnvironmentStatus> {
  const signal = options.signal ?? new AbortController().signal
  const deadline = Date.now() + PREPARATION_TIMEOUT_MS
  let releaseLock: (() => Promise<void>) | undefined
  let stateBeforeAction: ManagedPythonEnvironmentStatus['state'] | undefined
  try {
    const currentStatus = await getManagedPythonEnvironmentStatus(options)
    stateBeforeAction = currentStatus.state
    await publishOperationPhase(paths, 'remove', 'checking', currentStatus.state)
    if (currentStatus.managementBlocked) {
      throw new ManagedPythonEnvironmentError(
        'The managed Python environment is still in use. Close active Python sessions and retry.',
        'busy',
        'checking'
      )
    }
    releaseLock = await acquireProvisionLock(paths, signal, deadline)
    await publishOperationPhase(paths, 'remove', 'removing-environment', 'needs-repair')
    await removeManagedEnvironment(paths)
    await removeManagedInstallation(paths)
    const finalLeases = await scanLeases(paths)
    return await publishEnvironmentStatus(
      paths,
      createEnvironmentStatus(paths, 'not-installed', finalLeases)
    )
  } catch (error) {
    const phase = getActiveEnvironmentStatus(paths.rootPath)?.phase ?? 'checking'
    await publishOperationFailure(paths, 'remove', phase, error, stateBeforeAction).catch(
      () => undefined
    )
    throw error
  } finally {
    await releaseLock?.()
  }
}

async function performManagedEnvironmentAction(
  action: ManagedPythonEnvironmentAction,
  options: EnsureManagedPythonRuntimeOptions,
  paths: RuntimePaths
): Promise<ManagedPythonEnvironmentStatus> {
  if (action === 'remove') return await performRemoveEnvironment(options, paths)
  if (action === 'repair' || action === 'rebuild') {
    let stateBeforeAction: ManagedPythonEnvironmentStatus['state'] | undefined
    try {
      const currentStatus = await getManagedPythonEnvironmentStatus(options)
      stateBeforeAction = currentStatus.state
      if (currentStatus.managementBlocked) {
        throw new ManagedPythonEnvironmentError(
          'The managed Python environment is still in use. Close active Python sessions and retry.',
          'busy',
          'checking'
        )
      }
    } catch (error) {
      await publishOperationFailure(paths, action, 'checking', error, stateBeforeAction).catch(
        () => undefined
      )
      throw error
    }
  }
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    const resetMode: ManagedRuntimeResetMode =
      action === 'repair' ? 'environment' : action === 'rebuild' ? 'installation' : 'none'
    await prepareRuntime(options, paths, controller.signal, action, resetMode)
    const leases = await scanLeases(paths)
    return await publishEnvironmentStatus(paths, createEnvironmentStatus(paths, 'ready', leases))
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}

export async function manageManagedPythonEnvironment(
  action: ManagedPythonEnvironmentAction,
  options: EnsureManagedPythonRuntimeOptions
): Promise<ManagedPythonEnvironmentStatus> {
  throwIfAborted(options.signal)
  const paths = await createRuntimePaths(options.yachiyoHome)
  if (environmentManagementOperations.has(paths.rootPath) || preparations.has(paths.rootPath)) {
    throw new ManagedPythonEnvironmentError(
      'Another managed Python operation is already running.',
      'busy',
      'checking'
    )
  }
  const operation = performManagedEnvironmentAction(action, options, paths)
  environmentManagementOperations.set(paths.rootPath, operation)
  try {
    return await operation
  } finally {
    if (environmentManagementOperations.get(paths.rootPath) === operation) {
      environmentManagementOperations.delete(paths.rootPath)
    }
  }
}

export async function ensureManagedPythonRuntime(
  options: EnsureManagedPythonRuntimeOptions
): Promise<PythonRuntime> {
  throwIfAborted(options.signal)
  const paths = await createRuntimePaths(options.yachiyoHome)
  const managementOperation = environmentManagementOperations.get(paths.rootPath)
  if (managementOperation) await managementOperation
  throwIfAborted(options.signal)
  let entry = preparations.get(paths.rootPath)
  if (!entry) {
    const environmentPresent = await lstat(paths.environmentPath).then(
      () => true,
      (error: unknown) => {
        if (isNodeError(error, 'ENOENT')) return false
        throw error
      }
    )
    entry = preparations.get(paths.rootPath)
    if (!entry) {
      const controller = new AbortController()
      const action: ManagedPythonEnvironmentAction = environmentPresent ? 'repair' : 'install'
      const promise = prepareRuntime(options, paths, controller.signal, action, 'none')
        .catch((error: unknown) => {
          throw preparationFailure(error, paths.rootPath)
        })
        .finally(() => {
          const activeEntry = preparations.get(paths.rootPath)
          if (activeEntry?.controller !== controller) return
          activeEntry.settled = true
          preparations.delete(paths.rootPath)
        })
      const activeEntry: PreparationEntry = {
        controller,
        waiters: 0,
        settled: false,
        promise
      }
      entry = activeEntry
      preparations.set(paths.rootPath, activeEntry)
    }
  }
  const preparation = await waitForPreparation(entry, options.signal)
  const releaseHostLease = await acquireLease(preparation, process.pid, options.signal)
  let released = false
  return {
    kind: 'managed',
    rootPath: preparation.paths.rootPath,
    pythonPath: preparation.paths.pythonPath,
    uvPath: preparation.uvPath,
    environmentPath: preparation.paths.environmentPath,
    env: preparation.kernelEnv,
    version: PY_REPL_PYTHON_VERSION,
    acquireProcessLease: (pid, signal) => acquireLease(preparation, pid, signal),
    release: async (): Promise<void> => {
      if (released) return
      released = true
      await releaseHostLease()
    }
  }
}
