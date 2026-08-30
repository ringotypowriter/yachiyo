import { randomUUID } from 'node:crypto'
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
import { resolveBundledExecutable } from '../nativeExecutable.ts'
import type {
  ProcessBroker,
  ProcessJob,
  ProcessJobResult,
  ProcessOutputBatch
} from '../processBroker/processBroker.ts'
import {
  resolveWorkspacePythonEnvironment,
  type WorkspacePythonEnvironment
} from './workspacePythonEnvironment.ts'
import {
  assertManagedDirectory,
  assertOptionalManagedDirectory,
  canonicalForComparison,
  ensureManagedDirectory,
  hashFile,
  isNodeError,
  isPathInside,
  readBoundedFile,
  token,
  writePrivateFile
} from './managedPythonFilesystem.ts'

export { stagePythonRunner } from './managedPythonFilesystem.ts'

export const PY_REPL_UV_VERSION = '0.12.7'
export const PY_REPL_PYTHON_VERSION = '3.12.14'
export const PY_REPL_ENV_SCHEMA_VERSION = 3
export const PY_REPL_PREINSTALLED_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  numpy: '2.5.2',
  scipy: '1.18.1',
  pandas: '3.0.5',
  matplotlib: '3.11.1',
  Pillow: '12.3.0',
  'scikit-image': '0.26.0'
})

// Keep the existing path stable so marker upgrades can repair environments in place.
const RUNTIME_DIRECTORY_NAME = 'py-repl-cpython-3.12.14-uv-0.12.7-v2'
const PREINSTALLED_PACKAGE_REQUIREMENTS = Object.entries(PY_REPL_PREINSTALLED_PACKAGES).map(
  ([name, version]) => `${name}==${version}`
)
const PREPARATION_TIMEOUT_MS = 10 * 60 * 1000
const LOCK_POLL_INTERVAL_MS = 250
const JOB_OUTPUT_LIMIT_CHARS = 64_000
const TOKEN_PATTERN = /^[a-f0-9]{32}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const LOCK_FILE_PATTERN = /^\.provision-(\d+)-([a-f0-9]{32})\.lock$/u
const LEASE_FILE_PATTERN = /^(\d+)-([a-f0-9]{32})\.json$/u
const PROVISION_LOCK_FILE_NAME = 'provision.lock'
const READY_FILE_NAME = 'ready.json'
const LEASES_DIRECTORY_NAME = 'leases'

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
  pythonPath: string
  markerPath: string
  leasesPath: string
  provisionLockPath: string
}

interface RuntimePreparation {
  paths: RuntimePaths
  uvPath: string
  bootstrapEnv: Readonly<NodeJS.ProcessEnv>
  kernelEnv: Readonly<NodeJS.ProcessEnv>
  processBroker: ProcessBroker
  uvInvalidError: string
}

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

interface UvAssetAttestation {
  name: string
  version: string
  platform: string
  arch: string
  targetTriple: string
  archiveSha256: string
  outputSha256: string
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
  projectRoot?: string
  resourcesPath?: string
  yachiyoHome?: string
}

export interface EnsurePythonRuntimeOptions extends EnsureManagedPythonRuntimeOptions {
  workspacePath: string
}

const preparations = new Map<string, PreparationEntry>()

function abortError(): Error {
  const error = new Error('The Yachiyo Python runtime preparation was aborted.')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

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

  for (const path of [rootPath, cachePath, installationsPath, environmentsPath, runnersPath]) {
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
    pythonPath:
      process.platform === 'win32'
        ? join(environmentPath, 'Scripts', 'python.exe')
        : join(environmentPath, 'bin', 'python'),
    markerPath: join(environmentPath, READY_FILE_NAME),
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

function parseStrictObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function hasExactKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...names].sort()
  return (
    actual.length === expected.length && actual.every((name, index) => name === expected[index])
  )
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

async function scanLeases(paths: RuntimePaths): Promise<{ blocked: boolean }> {
  if (!(await assertOptionalManagedDirectory(paths.leasesPath, paths.homePath))) {
    return { blocked: false }
  }
  let blocked = false
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
      if (liveness === 'dead') await tokenSafeRemove(path, record)
      else blocked = true
    } catch {
      blocked = true
    }
  }
  return { blocked }
}

function bundledUvError(options: EnsureManagedPythonRuntimeOptions): Error {
  const target = `${process.platform}/${process.arch}`
  const sourceMode = options.projectRoot !== undefined || !import.meta.dirname.includes('.asar')
  return new Error(
    sourceMode
      ? `pyRepl's bundled uv runtime is missing or invalid for ${target}. Run pnpm binaries:download.`
      : `pyRepl's bundled uv runtime is missing or invalid for ${target}. Reinstall Yachiyo.`
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
    'outputSha256'
  ] as const
  if (!hasExactKeys(parsed, keys) || keys.some((key) => typeof parsed[key] !== 'string')) {
    throw new Error('Bundled uv attestation is malformed.')
  }
  return parsed as unknown as UvAssetAttestation
}

interface ManagedJobResult {
  stdout: string
  stderr: string
  result: ProcessJobResult
}

function appendBounded(current: string, text: string): string {
  const combined = current + text
  return combined.length <= JOB_OUTPUT_LIMIT_CHARS
    ? combined
    : combined.slice(combined.length - JOB_OUTPUT_LIMIT_CHARS)
}

function remainingSeconds(deadline: number): number {
  return Math.max(0.001, (deadline - Date.now()) / 1000)
}

async function runManagedJob(input: {
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<NodeJS.ProcessEnv>
  paths: RuntimePaths
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
  let stdout = ''
  let stderr = ''
  const handleOutput = (batch: ProcessOutputBatch): void => {
    for (const chunk of batch.chunks) {
      if (chunk.stream === 'stdout') stdout = appendBounded(stdout, chunk.text)
      else stderr = appendBounded(stderr, chunk.text)
    }
  }
  const abort = (): void => job?.cancel()
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
      spillThresholdChars: JOB_OUTPUT_LIMIT_CHARS
    })
    job.onOutput(handleOutput)
    if (process.platform !== 'win32') {
      await chmod(logPath, 0o600).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error
      })
    }
    if (input.signal.aborted) job.cancel()
    const result = await job.wait()
    jobSettled = true
    throwIfAborted(input.signal)
    if (result.timedOut) throw new Error('Python runtime preparation timed out.')
    return { stdout, stderr, result }
  } finally {
    input.signal.removeEventListener('abort', abort)
    if (job && !jobSettled) {
      job.cancel()
      await job.wait().catch(() => undefined)
    }
    await rm(logPath, { force: true }).catch(() => undefined)
  }
}

async function resolveAttestedUv(options: EnsureManagedPythonRuntimeOptions): Promise<string> {
  const name = process.platform === 'win32' ? 'uv.exe' : 'uv'
  const targetTriple = TARGET_TRIPLES[process.platform]?.[process.arch]
  if (!targetTriple) throw bundledUvError(options)
  const uvPath = resolveBundledExecutable({
    name,
    projectRoot: options.projectRoot,
    resourcesPath: options.resourcesPath,
    startDir: import.meta.dirname
  })
  if (!uvPath || !isAbsolute(uvPath)) throw bundledUvError(options)
  try {
    const executableStat = await lstat(uvPath)
    if (!executableStat.isFile() || executableStat.isSymbolicLink()) throw new Error('invalid uv')
    const attestationPath = `${uvPath}.asset.json`
    const attestationStat = await lstat(attestationPath)
    if (!attestationStat.isFile() || attestationStat.isSymbolicLink()) throw new Error('invalid uv')
    const attestation = parseAttestation(await readBoundedFile(attestationPath, 16 * 1024))
    if (
      attestation.name !== 'uv' ||
      attestation.version !== PY_REPL_UV_VERSION ||
      attestation.platform !== process.platform ||
      attestation.arch !== process.arch ||
      attestation.targetTriple !== targetTriple ||
      !SHA256_PATTERN.test(attestation.archiveSha256) ||
      !SHA256_PATTERN.test(attestation.outputSha256) ||
      (await hashFile(uvPath)) !== attestation.outputSha256
    ) {
      throw new Error('invalid uv')
    }
    return uvPath
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw bundledUvError(options)
  }
}

async function attestUvExecutable(
  preparation: RuntimePreparation,
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
    if (probe.result.exitCode !== 0) throw new Error('invalid uv')
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
    throw new Error(preparation.uvInvalidError)
  }
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

async function removeInvalidEnvironment(paths: RuntimePaths): Promise<void> {
  if (!(await assertOptionalManagedDirectory(paths.environmentPath, paths.homePath))) return
  const leases = await scanLeases(paths)
  if (leases.blocked) {
    throw new Error(
      `Yachiyo Python ${PY_REPL_PYTHON_VERSION} needs repair but is still in use by another Yachiyo process. Close it and retry.`
    )
  }
  await assertManagedDirectory(paths.environmentPath, paths.homePath)
  await rm(paths.environmentPath, { recursive: true, force: true })
}

function commandFailure(name: string, job: ManagedJobResult): Error {
  const diagnostics = (
    job.stderr.trim() ||
    job.stdout.trim() ||
    `exit status ${job.result.exitCode}`
  ).slice(-JOB_OUTPUT_LIMIT_CHARS)
  return new Error(`${name} failed with exit status ${job.result.exitCode}: ${diagnostics}`)
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
  deadline: number
): Promise<void> {
  const { paths } = preparation
  const releaseLock = await acquireProvisionLock(paths, signal, deadline)
  let replacedEnvironment = false
  try {
    const healthy = await runHealthProbe(preparation, signal, deadline, false)
    if (healthy) {
      await compileEnvironmentBytecode(preparation, signal, deadline)
      await warmScipy(preparation, signal, deadline)
      await ensureManagedDirectory(paths.leasesPath, paths.homePath)
      await scanLeases(paths)
      if (!(await markerMatches(paths))) await writeReadyMarker(paths)
      return
    }
    await attestUvExecutable(preparation, signal, deadline)

    await removeInvalidEnvironment(paths)
    replacedEnvironment = true
    await ensureManagedDirectory(paths.installationPath, paths.homePath)
    await assertProvisionAnchors(paths)
    const installationJob = await runManagedJob({
      executable: preparation.uvPath,
      args: [
        '--no-config',
        '--no-progress',
        'python',
        'install',
        '--reinstall',
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
      throw commandFailure('Bundled uv Python installation', installationJob)
    }

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
    if (venvJob.result.exitCode !== 0)
      throw commandFailure('Bundled uv virtualenv creation', venvJob)
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
      throw commandFailure('Bundled uv scientific package installation', packageJob)
    }
    await warmScipy(preparation, signal, deadline)
    if (!(await runHealthProbe(preparation, signal, deadline, true, true))) {
      throw new Error('The private Python environment failed its isolated health check.')
    }
    await ensureManagedDirectory(paths.leasesPath, paths.homePath)
    await writeReadyMarker(paths)
  } catch (error) {
    if (replacedEnvironment) {
      await removeInvalidEnvironment(paths).catch(() => undefined)
    }
    throw error
  } finally {
    await releaseLock()
  }
}

async function prepareRuntime(
  options: EnsureManagedPythonRuntimeOptions,
  paths: RuntimePaths,
  signal: AbortSignal
): Promise<RuntimePreparation> {
  const deadline = Date.now() + PREPARATION_TIMEOUT_MS
  const environments = buildRuntimeEnvironments(paths)
  const uvPath = await resolveAttestedUv(options)
  const preparation: RuntimePreparation = {
    paths,
    uvPath,
    ...environments,
    processBroker: options.processBroker,
    uvInvalidError: bundledUvError(options).message
  }
  const healthy = await runHealthProbe(preparation, signal, deadline, false)
  if (healthy && (await markerMatches(paths))) {
    await ensureManagedDirectory(paths.leasesPath, paths.homePath)
    await scanLeases(paths)
  } else {
    await provisionRuntime(preparation, signal, deadline)
  }
  if (
    !(await markerMatches(paths)) ||
    !(await runHealthProbe(preparation, signal, deadline, false))
  ) {
    throw new Error('The private Python environment did not remain healthy after preparation.')
  }
  return preparation
}

function preparationFailure(error: unknown, rootPath: string): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  if (
    error instanceof Error &&
    (error.message.startsWith("pyRepl's bundled uv runtime") ||
      error.message.startsWith('Timed out waiting') ||
      error.message.includes('needs repair but is still in use'))
  ) {
    return error
  }
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(
    `Could not prepare Yachiyo Python ${PY_REPL_PYTHON_VERSION} in ${rootPath}: ${reason.slice(-JOB_OUTPUT_LIMIT_CHARS)}. pyRepl did not use system Python. Check network/proxy settings and retry.`
  )
}

function waitForPreparation(
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
  return caller.finally(() => {
    removeAbortListener()
    entry.waiters -= 1
    if (entry.waiters === 0 && !entry.settled) entry.controller.abort()
  })
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
        await provisionRuntime(preparation, leaseSignal, deadline)
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
  const deadline = Date.now() + WORKSPACE_PROBE_TIMEOUT_MS
  const probeResult = await runManagedJob({
    executable: workspace.pythonPath,
    args: ['-I', '-c', WORKSPACE_HEALTH_PROBE],
    cwd: workspace.workspacePath,
    env: environments.kernelEnv,
    paths,
    processBroker: options.processBroker,
    signal,
    deadline
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
  const uvPath = await resolveAttestedUv(options)
  const preparation: RuntimePreparation = {
    paths,
    uvPath,
    bootstrapEnv: environments.bootstrapEnv,
    kernelEnv: environments.kernelEnv,
    processBroker: options.processBroker,
    uvInvalidError: bundledUvError(options).message
  }
  await attestUvExecutable(preparation, signal, deadline)
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

export async function ensureManagedPythonRuntime(
  options: EnsureManagedPythonRuntimeOptions
): Promise<PythonRuntime> {
  throwIfAborted(options.signal)
  const paths = await createRuntimePaths(options.yachiyoHome)
  throwIfAborted(options.signal)
  let entry = preparations.get(paths.rootPath)
  if (!entry) {
    const controller = new AbortController()
    const promise = prepareRuntime(options, paths, controller.signal)
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
