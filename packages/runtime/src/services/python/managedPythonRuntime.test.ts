import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'

import type {
  ProcessBroker,
  ProcessJob,
  ProcessJobOutcome,
  ProcessJobResult,
  ProcessOutputBatch,
  StartProcessJobInput
} from '../processBroker/processBroker.ts'
import {
  ensureManagedPythonRuntime,
  ensurePythonRuntime,
  PY_REPL_ENV_SCHEMA_VERSION,
  PY_REPL_PREINSTALLED_PACKAGES,
  PY_REPL_PYTHON_VERSION,
  PY_REPL_UV_VERSION,
  type PythonRuntime
} from './managedPythonRuntime.ts'

type DirectProcessJobInput = Extract<StartProcessJobInput, { executable: string }>

function isDirectProcessJobInput(input: StartProcessJobInput): input is DirectProcessJobInput {
  return typeof input.executable === 'string' && Array.isArray(input.args)
}

const runtimeDirectoryName = 'py-repl-cpython-3.12.14-uv-0.12.7-v2'
const targetTriples: Readonly<Record<string, string>> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc'
}
const preinstalledRequirements = Object.entries(PY_REPL_PREINSTALLED_PACKAGES).map(
  ([name, version]) => `${name}==${version}`
)

interface FakeResponse {
  stdout?: string
  stderr?: string
  exitCode?: number
  timedOut?: boolean
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  return Promise.withResolvers<T>()
}

function result(overrides: Partial<ProcessJobResult> = {}): ProcessJobResult {
  return {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    spilled: false,
    totalBytes: 0,
    ...overrides
  }
}

class FakeProcessJob implements ProcessJob {
  readonly id: string
  readonly pid = process.pid
  readonly logPath: string
  private readonly listeners = new Set<(batch: ProcessOutputBatch) => void>()
  private readonly cancelled = deferred<void>()
  private settled: Promise<ProcessJobResult> | undefined
  private readonly response: Promise<FakeResponse>
  private readonly onCancel: () => void

  constructor(input: StartProcessJobInput, response: Promise<FakeResponse>, onCancel: () => void) {
    this.id = input.id
    this.logPath = input.logPath
    this.response = response
    this.onCancel = onCancel
  }

  onOutput(listener: (batch: ProcessOutputBatch) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  waitForOutcome(): Promise<ProcessJobOutcome> {
    return this.wait().then((jobResult) => ({ kind: 'exited' as const, result: jobResult }))
  }

  wait(): Promise<ProcessJobResult> {
    this.settled ??= this.finish()
    return this.settled
  }

  cancel(): void {
    this.onCancel()
    this.cancelled.resolve()
  }

  private async finish(): Promise<ProcessJobResult> {
    const response = await Promise.race([
      this.response.then((value) => ({ kind: 'response' as const, value })),
      this.cancelled.promise.then(() => ({ kind: 'cancelled' as const }))
    ])
    if (response.kind === 'cancelled') return result({ cancelled: true })

    const chunks = [
      ...(response.value.stdout
        ? [{ stream: 'stdout' as const, text: response.value.stdout }]
        : []),
      ...(response.value.stderr ? [{ stream: 'stderr' as const, text: response.value.stderr }] : [])
    ]
    if (chunks.length > 0) {
      const batch: ProcessOutputBatch = {
        sequence: 1,
        chunks,
        truncated: false,
        totalBytes: chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0)
      }
      for (const listener of this.listeners) listener(batch)
    }
    return result({
      exitCode: response.value.exitCode ?? 0,
      timedOut: response.value.timedOut ?? false,
      totalBytes: chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0)
    })
  }
}

class ManagedRuntimeBrokerFake implements ProcessBroker {
  readonly inputs: DirectProcessJobInput[] = []
  cancelledJobs = 0
  environmentWasEmptyBeforeVenv = false
  failInstall = false
  installationResponse: FakeResponse | undefined
  packageResponse: FakeResponse | undefined
  healthBasePrefixOverride: string | undefined
  healthPackageVersionsOverride: Readonly<Record<string, string>> | undefined
  workspaceImplementation = 'cpython'
  workspaceVersion = '3.11.14'
  workspacePrefixOverride: string | undefined
  workspaceBasePrefixOverride: string | undefined
  blockNextMatching:
    | {
        match(input: DirectProcessJobInput): boolean
        remainingMatches?: number
        started: Deferred<void>
        release: Deferred<void>
      }
    | undefined

  start(): Promise<void> {
    return Promise.resolve()
  }

  async startJob(input: StartProcessJobInput): Promise<ProcessJob> {
    if (!isDirectProcessJobInput(input)) {
      throw new Error('managed Python must use the direct executable branch')
    }
    this.inputs.push(input)
    const response = this.handle(input)
    void response.catch(() => undefined)
    return new FakeProcessJob(input, response, () => {
      this.cancelledJobs += 1
    })
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  private async handle(input: DirectProcessJobInput): Promise<FakeResponse> {
    const blocker = this.blockNextMatching
    if (blocker?.match(input)) {
      const remainingMatches = blocker.remainingMatches ?? 1
      if (remainingMatches > 1) {
        blocker.remainingMatches = remainingMatches - 1
      } else {
        this.blockNextMatching = undefined
        blocker.started.resolve()
        await blocker.release.promise
      }
    }

    const executable = input.executable
    const args = [...input.args]
    const environmentPath =
      process.platform === 'win32' ? dirname(dirname(executable)) : dirname(dirname(executable))
    const isPythonProbe = args[0] === '-I' && args[1] === '-c'
    const isWorkspaceProbe = isPythonProbe && args[2]?.includes('sys.implementation.name') === true

    if (isWorkspaceProbe) {
      return {
        stdout: `${JSON.stringify({
          implementation: this.workspaceImplementation,
          version: this.workspaceVersion,
          prefix: this.workspacePrefixOverride ?? (await realpath(environmentPath)),
          basePrefix:
            this.workspaceBasePrefixOverride ?? join(dirname(environmentPath), 'workspace-python')
        })}\n`
      }
    }

    if (isPythonProbe) {
      const installationPath = input.env['UV_PYTHON_INSTALL_DIR']
      assert.ok(installationPath)
      const basePrefix =
        this.healthBasePrefixOverride ?? join(installationPath, 'managed-cpython-base')
      return {
        stdout: `${JSON.stringify({
          version: PY_REPL_PYTHON_VERSION,
          prefix: await realpath(environmentPath),
          basePrefix: await realpath(basePrefix).catch(() => basePrefix),
          pipOrigin: join(
            environmentPath,
            'lib',
            'python3.12',
            'site-packages',
            'pip',
            '__init__.py'
          ),
          packages: this.healthPackageVersionsOverride ?? PY_REPL_PREINSTALLED_PACKAGES
        })}\n`
      }
    }

    if (args.join('\0') === ['self', 'version', '--output-format', 'json'].join('\0')) {
      return {
        stdout: `${JSON.stringify({
          package_name: 'uv',
          version: PY_REPL_UV_VERSION,
          target_triple: targetTriples[`${process.platform}-${process.arch}`]
        })}\n`
      }
    }

    if (args.includes('install') && args.includes('--install-dir')) {
      if (this.failInstall) throw new Error('installation intentionally rejected by test')
      if (this.installationResponse) return this.installationResponse
      const installationPath = args[args.indexOf('--install-dir') + 1]
      assert.ok(installationPath)
      await mkdir(join(installationPath, 'managed-cpython-base'), { recursive: true })
      return {}
    }

    if (args.includes('pip') && args.includes('install')) {
      if (this.packageResponse) return this.packageResponse
      return {}
    }

    if (args.includes('venv')) {
      const target = args.at(-1)
      assert.ok(target)
      this.environmentWasEmptyBeforeVenv = (await readdir(target)).length === 0
      const pythonPath =
        process.platform === 'win32'
          ? join(target, 'Scripts', 'python.exe')
          : join(target, 'bin', 'python')
      await mkdir(dirname(pythonPath), { recursive: true })
      await writeFile(pythonPath, 'managed-python')
      if (process.platform !== 'win32') await chmod(pythonPath, 0o700)
      await mkdir(join(target, 'lib', 'python3.12', 'site-packages', 'pip'), { recursive: true })
      return {}
    }

    throw new Error(`Unexpected managed runtime job: ${executable} ${args.join(' ')}`)
  }
}

interface RuntimeFixture {
  root: string
  home: string
  resources: string
  uvPath: string
  broker: ManagedRuntimeBrokerFake
  cleanup(): Promise<void>
}

async function createRuntimeFixture(): Promise<RuntimeFixture> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'yachiyo-managed-python-'))
  const root = await realpath(temporaryRoot)
  const home = join(root, 'yachiyo-home')
  const resources = join(root, 'resources')
  const binaryName = process.platform === 'win32' ? 'uv.exe' : 'uv'
  const uvPath = join(resources, 'bin', binaryName)
  const uvBytes = Buffer.from('pinned-uv-test-binary')
  const targetTriple = targetTriples[`${process.platform}-${process.arch}`]
  assert.ok(
    targetTriple,
    `test fixture lacks target triple for ${process.platform}/${process.arch}`
  )
  await mkdir(dirname(uvPath), { recursive: true })
  await writeFile(uvPath, uvBytes)
  if (process.platform !== 'win32') await chmod(uvPath, 0o700)
  await writeFile(
    `${uvPath}.asset.json`,
    JSON.stringify({
      name: 'uv',
      version: PY_REPL_UV_VERSION,
      platform: process.platform,
      arch: process.arch,
      targetTriple,
      archiveSha256: 'a'.repeat(64),
      outputSha256: createHash('sha256').update(uvBytes).digest('hex')
    })
  )
  const broker = new ManagedRuntimeBrokerFake()
  return {
    root,
    home,
    resources,
    uvPath,
    broker,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

function expectedPaths(home: string): {
  rootPath: string
  installationPath: string
  environmentPath: string
  pythonPath: string
  leasesPath: string
} {
  const rootPath = join(home, 'python')
  const installationPath = join(rootPath, 'installations', runtimeDirectoryName)
  const environmentPath = join(rootPath, 'environments', runtimeDirectoryName)
  return {
    rootPath,
    installationPath,
    environmentPath,
    pythonPath:
      process.platform === 'win32'
        ? join(environmentPath, 'Scripts', 'python.exe')
        : join(environmentPath, 'bin', 'python'),
    leasesPath: join(environmentPath, 'leases')
  }
}

async function ensureFixtureRuntime(
  fixture: RuntimeFixture,
  signal?: AbortSignal
): Promise<PythonRuntime> {
  return ensureManagedPythonRuntime({
    processBroker: fixture.broker,
    resourcesPath: fixture.resources,
    yachiyoHome: fixture.home,
    signal
  })
}

async function createWorkspaceEnvironment(workspacePath: string): Promise<{
  environmentPath: string
  pythonPath: string
}> {
  const environmentPath = join(workspacePath, '.venv')
  const pythonPath =
    process.platform === 'win32'
      ? join(environmentPath, 'Scripts', 'python.exe')
      : join(environmentPath, 'bin', 'python')
  await mkdir(dirname(pythonPath), { recursive: true })
  await writeFile(pythonPath, 'workspace-python')
  if (process.platform !== 'win32') await chmod(pythonPath, 0o700)
  return { environmentPath: await realpath(environmentPath), pythonPath }
}

async function waitUntil(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message)
    await sleep(10)
  }
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = Promise.withResolvers<void>()
  child.once('exit', exited.resolve)
  child.kill()
  await exited.promise
}

test('provisions the private runtime with literal jobs, scrubbed env, and private paths', async () => {
  const fixture = await createRuntimeFixture()
  const paths = expectedPaths(fixture.home)
  const previousHome = process.env['YACHIYO_HOME']
  const previousSecret = process.env['YACHIYO_MANAGED_TEST_SECRET']
  const previousVirtualEnv = process.env['VIRTUAL_ENV']
  const previousPipConfig = process.env['PIP_CONFIG_FILE']
  await mkdir(paths.environmentPath, { recursive: true })
  await writeFile(join(paths.environmentPath, 'partial-install'), 'discard me')
  process.env['YACHIYO_HOME'] = fixture.home
  process.env['YACHIYO_MANAGED_TEST_SECRET'] = 'must-not-leak'
  process.env['VIRTUAL_ENV'] = '/external/venv'
  process.env['PIP_CONFIG_FILE'] = '/external/pip.conf'

  let runtime: PythonRuntime | undefined
  try {
    runtime = await ensureManagedPythonRuntime({
      processBroker: fixture.broker,
      resourcesPath: fixture.resources
    })

    assert.equal(runtime.rootPath, await realpath(paths.rootPath))
    assert.equal(runtime.pythonPath, paths.pythonPath)
    assert.equal(runtime.environmentPath, paths.environmentPath)
    assert.equal(runtime.uvPath, fixture.uvPath)
    assert.equal(runtime.version, PY_REPL_PYTHON_VERSION)
    assert.equal(runtime.kind, 'managed')
    assert.equal(runtime.env['VIRTUAL_ENV'], paths.environmentPath)
    assert.equal(runtime.env['YACHIYO_MANAGED_TEST_SECRET'], undefined)
    assert.equal(runtime.env['PIP_CONFIG_FILE'], undefined)
    assert.equal(fixture.broker.environmentWasEmptyBeforeVenv, true)
    const marker = JSON.parse(
      await readFile(join(paths.environmentPath, 'ready.json'), 'utf8')
    ) as Record<string, unknown>
    assert.equal(marker['schemaVersion'], PY_REPL_ENV_SCHEMA_VERSION)

    const directInputs = fixture.broker.inputs
    assert.ok(directInputs.length >= 5)
    for (const input of directInputs) {
      assert.ok('executable' in input)
      assert.equal(input.env['YACHIYO_MANAGED_TEST_SECRET'], undefined)
      assert.equal(input.env['VIRTUAL_ENV'], undefined)
      assert.equal(input.env['PIP_CONFIG_FILE'], undefined)
      assert.equal(input.cwd, paths.rootPath)
    }

    assert.ok(
      directInputs.some(
        (input) =>
          input.args.join('\0') === ['self', 'version', '--output-format', 'json'].join('\0')
      )
    )
    assert.ok(
      directInputs.some(
        (input) =>
          input.args.join('\0') ===
          [
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
          ].join('\0')
      )
    )
    assert.ok(
      directInputs.some(
        (input) =>
          input.args.join('\0') ===
          [
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
          ].join('\0')
      )
    )
    assert.ok(
      directInputs.some(
        (input) =>
          input.args.join('\0') ===
          [
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
            ...preinstalledRequirements
          ].join('\0')
      )
    )
    assert.ok(
      directInputs.some(
        (input) =>
          input.args[0] === '-I' &&
          input.args[1] === '-c' &&
          input.args[2]?.includes('from scipy import stats')
      ),
      'A new environment must warm SciPy before becoming ready.'
    )

    if (process.platform !== 'win32') {
      for (const directory of [
        paths.rootPath,
        join(paths.rootPath, 'cache'),
        join(paths.rootPath, 'installations'),
        paths.installationPath,
        join(paths.rootPath, 'environments'),
        paths.environmentPath,
        paths.leasesPath
      ]) {
        assert.equal((await stat(directory)).mode & 0o777, 0o700, directory)
      }
      const leaseName = (await readdir(paths.leasesPath)).find((name) =>
        name.startsWith(`${process.pid}-`)
      )
      assert.ok(leaseName)
      assert.equal((await stat(join(paths.leasesPath, leaseName))).mode & 0o777, 0o600)
    }
  } finally {
    await runtime?.release()
    if (previousHome === undefined) delete process.env['YACHIYO_HOME']
    else process.env['YACHIYO_HOME'] = previousHome
    if (previousSecret === undefined) delete process.env['YACHIYO_MANAGED_TEST_SECRET']
    else process.env['YACHIYO_MANAGED_TEST_SECRET'] = previousSecret
    if (previousVirtualEnv === undefined) delete process.env['VIRTUAL_ENV']
    else process.env['VIRTUAL_ENV'] = previousVirtualEnv
    if (previousPipConfig === undefined) delete process.env['PIP_CONFIG_FILE']
    else process.env['PIP_CONFIG_FILE'] = previousPipConfig
    await fixture.cleanup()
  }
})

test('selects a valid workspace root .venv without provisioning a managed environment', async () => {
  const fixture = await createRuntimeFixture()
  const workspacePath = join(fixture.root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const workspace = await createWorkspaceEnvironment(workspacePath)
  let runtime: PythonRuntime | undefined

  try {
    runtime = await ensurePythonRuntime({
      processBroker: fixture.broker,
      resourcesPath: fixture.resources,
      yachiyoHome: fixture.home,
      workspacePath
    })

    assert.equal(runtime.kind, 'workspace')
    assert.equal(runtime.rootPath, await realpath(expectedPaths(fixture.home).rootPath))
    assert.equal(runtime.environmentPath, workspace.environmentPath)
    assert.equal(runtime.pythonPath, workspace.pythonPath)
    assert.equal(runtime.version, fixture.broker.workspaceVersion)
    assert.equal(runtime.env['VIRTUAL_ENV'], workspace.environmentPath)
    assert.equal(runtime.env['UV_MANAGED_PYTHON'], undefined)
    assert.match(
      runtime.env['PATH'] ?? '',
      new RegExp(
        `^${workspace.environmentPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[\\\\/]${process.platform === 'win32' ? 'Scripts' : 'bin'}`
      )
    )
    assert.equal(fixture.broker.inputs.filter((input) => input.args.includes('install')).length, 0)
    assert.equal(fixture.broker.inputs.filter((input) => input.args.includes('venv')).length, 0)
    assert.equal(fixture.broker.inputs.filter((input) => input.args.includes('pip')).length, 0)
    assert.ok(
      fixture.broker.inputs.some(
        (input) =>
          input.executable === workspace.pythonPath &&
          input.args[0] === '-I' &&
          input.args[1] === '-c'
      )
    )
    assert.ok(
      fixture.broker.inputs.some(
        (input) =>
          input.args.join('\0') === ['self', 'version', '--output-format', 'json'].join('\0')
      )
    )

    const preAborted = new AbortController()
    preAborted.abort()
    await assert.rejects(
      runtime.acquireProcessLease(process.pid, preAborted.signal),
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    )
    const releaseLease = await runtime.acquireProcessLease(process.pid)
    await releaseLease()
    await releaseLease()
  } finally {
    await runtime?.release()
    await fixture.cleanup()
  }
})

test('falls back to the managed environment only when workspace .venv is absent', async () => {
  const fixture = await createRuntimeFixture()
  const workspacePath = join(fixture.root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  let runtime: PythonRuntime | undefined

  try {
    runtime = await ensurePythonRuntime({
      processBroker: fixture.broker,
      resourcesPath: fixture.resources,
      yachiyoHome: fixture.home,
      workspacePath
    })

    assert.equal(runtime.kind, 'managed')
    assert.equal(runtime.version, PY_REPL_PYTHON_VERSION)
    assert.ok(fixture.broker.inputs.some((input) => input.args.includes('venv')))
  } finally {
    await runtime?.release()
    await fixture.cleanup()
  }
})

test('fails closed when workspace .venv exists but is unusable', async (context) => {
  await context.test('missing interpreter', async () => {
    const fixture = await createRuntimeFixture()
    const workspacePath = join(fixture.root, 'workspace')
    await mkdir(join(workspacePath, '.venv'), { recursive: true })
    try {
      await assert.rejects(
        ensurePythonRuntime({
          processBroker: fixture.broker,
          resourcesPath: fixture.resources,
          yachiyoHome: fixture.home,
          workspacePath
        }),
        /\.venv Python executable is missing or unusable/u
      )
      assert.equal(fixture.broker.inputs.length, 0)
    } finally {
      await fixture.cleanup()
    }
  })

  await context.test('unsupported Python version', async () => {
    const fixture = await createRuntimeFixture()
    const workspacePath = join(fixture.root, 'workspace')
    await mkdir(workspacePath, { recursive: true })
    await createWorkspaceEnvironment(workspacePath)
    fixture.broker.workspaceVersion = '3.10.14'
    try {
      await assert.rejects(
        ensurePythonRuntime({
          processBroker: fixture.broker,
          resourcesPath: fixture.resources,
          yachiyoHome: fixture.home,
          workspacePath
        }),
        /requires CPython 3\.11 or newer/u
      )
      assert.equal(
        fixture.broker.inputs.some(
          (input) => input.args.includes('install') || input.args.includes('venv')
        ),
        false
      )
    } finally {
      await fixture.cleanup()
    }
  })

  await context.test('interpreter is not bound to the .venv', async () => {
    const fixture = await createRuntimeFixture()
    const workspacePath = join(fixture.root, 'workspace')
    await mkdir(workspacePath, { recursive: true })
    const workspace = await createWorkspaceEnvironment(workspacePath)
    fixture.broker.workspaceBasePrefixOverride = workspace.environmentPath
    try {
      await assert.rejects(
        ensurePythonRuntime({
          processBroker: fixture.broker,
          resourcesPath: fixture.resources,
          yachiyoHome: fixture.home,
          workspacePath
        }),
        /is not a virtual environment/u
      )
      assert.equal(
        fixture.broker.inputs.some(
          (input) => input.args.includes('install') || input.args.includes('venv')
        ),
        false
      )
    } finally {
      await fixture.cleanup()
    }
  })
})

test('fails closed on symbolic-link and non-directory managed anchors before spawning', async (t) => {
  await t.test('symbolic-link root', async () => {
    const fixture = await createRuntimeFixture()
    try {
      const outside = join(fixture.root, 'outside')
      await mkdir(fixture.home, { recursive: true })
      await mkdir(outside, { recursive: true })
      await symlink(
        outside,
        join(fixture.home, 'python'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      await assert.rejects(
        ensureFixtureRuntime(fixture),
        /symbolic link|changed or leaves YACHIYO_HOME/u
      )
      assert.equal(fixture.broker.inputs.length, 0)
    } finally {
      await fixture.cleanup()
    }
  })

  await t.test('non-directory cache anchor', async () => {
    const fixture = await createRuntimeFixture()
    try {
      await mkdir(join(fixture.home, 'python'), { recursive: true })
      await writeFile(join(fixture.home, 'python', 'cache'), 'not a directory')
      await assert.rejects(ensureFixtureRuntime(fixture), /EEXIST|not a private directory/u)
      assert.equal(fixture.broker.inputs.length, 0)
    } finally {
      await fixture.cleanup()
    }
  })
})

test('rejects a ready environment whose base prefix leaves the versioned installation', async () => {
  const fixture = await createRuntimeFixture()
  let runtime: PythonRuntime | undefined
  try {
    runtime = await ensureFixtureRuntime(fixture)
    await runtime.release()
    runtime = undefined
    const existingInputCount = fixture.broker.inputs.length
    const outsideBase = join(fixture.root, 'external-python')
    await mkdir(outsideBase, { recursive: true })
    fixture.broker.healthBasePrefixOverride = outsideBase
    fixture.broker.failInstall = true

    await assert.rejects(ensureFixtureRuntime(fixture), /installation intentionally rejected/u)
    assert.ok(fixture.broker.inputs.length > existingInputCount)
    assert.ok(fixture.broker.inputs.some((input) => input.args.includes('install')))
  } finally {
    await runtime?.release()
    await fixture.cleanup()
  }
})

test('preserves changed baseline versions but repairs missing baseline packages', async (t) => {
  await t.test('changed version', async () => {
    const fixture = await createRuntimeFixture()
    let runtime: PythonRuntime | undefined
    try {
      runtime = await ensureFixtureRuntime(fixture)
      await runtime.release()
      runtime = undefined
      fixture.broker.healthPackageVersionsOverride = {
        ...PY_REPL_PREINSTALLED_PACKAGES,
        numpy: '9.9.9'
      }
      const firstNewInput = fixture.broker.inputs.length

      runtime = await ensureFixtureRuntime(fixture)
      const newInputs = fixture.broker.inputs.slice(firstNewInput)
      assert.equal(
        newInputs.some(
          (input) =>
            input.args.includes('--install-dir') ||
            (input.args.includes('pip') && input.args.includes('install'))
        ),
        false
      )
    } finally {
      await runtime?.release()
      await fixture.cleanup()
    }
  })

  await t.test('missing package', async () => {
    const fixture = await createRuntimeFixture()
    let runtime: PythonRuntime | undefined
    try {
      runtime = await ensureFixtureRuntime(fixture)
      await runtime.release()
      runtime = undefined
      const packageVersions = { ...PY_REPL_PREINSTALLED_PACKAGES }
      delete packageVersions['numpy']
      fixture.broker.healthPackageVersionsOverride = packageVersions
      fixture.broker.failInstall = true
      const firstNewInput = fixture.broker.inputs.length

      await assert.rejects(ensureFixtureRuntime(fixture), /installation intentionally rejected/u)
      assert.ok(
        fixture.broker.inputs
          .slice(firstNewInput)
          .some((input) => input.args.includes('--install-dir'))
      )
    } finally {
      await runtime?.release()
      await fixture.cleanup()
    }
  })
})

test('repairs corrupted, partial, and mismatched readiness markers without reinstalling', async () => {
  const fixture = await createRuntimeFixture()
  const markerPath = join(expectedPaths(fixture.home).environmentPath, 'ready.json')
  let runtime: PythonRuntime | undefined
  try {
    runtime = await ensureFixtureRuntime(fixture)
    await runtime.release()
    runtime = undefined
    const validMarker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
    const invalidMarkers = [
      '{',
      JSON.stringify({ schemaVersion: PY_REPL_ENV_SCHEMA_VERSION }),
      JSON.stringify({ ...validMarker, schemaVersion: PY_REPL_ENV_SCHEMA_VERSION - 1 }),
      JSON.stringify({ ...validMarker, uvVersion: '0.0.0' })
    ]

    for (const invalidMarker of invalidMarkers) {
      await writeFile(markerPath, invalidMarker)
      const firstNewInput = fixture.broker.inputs.length
      runtime = await ensureFixtureRuntime(fixture)
      const repairInputs = fixture.broker.inputs.slice(firstNewInput)
      assert.equal(
        repairInputs.some((input) => input.args.includes('install')),
        false
      )
      assert.ok(
        repairInputs.some(
          (input) =>
            input.args[0] === '-I' &&
            input.args[1] === '-c' &&
            input.args[2]?.includes('compileall.compile_dir')
        ),
        'A healthy environment with a stale marker must compile its existing bytecode.'
      )
      assert.ok(
        repairInputs.some(
          (input) =>
            input.args[0] === '-I' &&
            input.args[1] === '-c' &&
            input.args[2]?.includes('from scipy import stats')
        ),
        'A healthy environment with a stale marker must warm SciPy before becoming ready.'
      )
      assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), validMarker)
      await runtime.release()
      runtime = undefined
    }
  } finally {
    await runtime?.release()
    await fixture.cleanup()
  }
})

test('removes partial environments and locks after bootstrap failures', async (t) => {
  const failures: ReadonlyArray<{
    name: string
    target: 'python' | 'packages'
    response: FakeResponse
    expected: RegExp
  }> = [
    {
      name: 'Python installation crash',
      target: 'python',
      response: { exitCode: 9, stderr: 'simulated installer crash' },
      expected: /simulated installer crash/u
    },
    {
      name: 'Python installation timeout',
      target: 'python',
      response: { timedOut: true },
      expected: /preparation timed out/u
    },
    {
      name: 'scientific package installation failure',
      target: 'packages',
      response: { exitCode: 1, stderr: 'simulated scientific package resolution failure' },
      expected: /simulated scientific package resolution failure/u
    }
  ]

  for (const failure of failures) {
    await t.test(failure.name, async () => {
      const fixture = await createRuntimeFixture()
      const paths = expectedPaths(fixture.home)
      if (failure.target === 'python') fixture.broker.installationResponse = failure.response
      else fixture.broker.packageResponse = failure.response
      try {
        await assert.rejects(ensureFixtureRuntime(fixture), failure.expected)
        assert.equal(await lstat(paths.environmentPath).catch(() => undefined), undefined)
        const rootEntries = await readdir(paths.rootPath)
        assert.equal(
          rootEntries.some((name) => name === 'provision.lock' || name.startsWith('.provision-')),
          false
        )
      } finally {
        await fixture.cleanup()
      }
    })
  }
})

test('recovers dead provisioning locks and never steals a live process lock', async (t) => {
  await t.test('dead owner and orphan', async () => {
    const fixture = await createRuntimeFixture()
    const rootPath = expectedPaths(fixture.home).rootPath
    const deadPid = 2_147_483_647
    const fixedToken = 'a'.repeat(32)
    const orphanToken = 'b'.repeat(32)
    const fixedPath = join(rootPath, 'provision.lock')
    const orphanPath = join(rootPath, `.provision-${deadPid}-${orphanToken}.lock`)
    await mkdir(rootPath, { recursive: true })
    await writeFile(
      fixedPath,
      JSON.stringify({ pid: deadPid, token: fixedToken, startedAt: Date.now() })
    )
    await writeFile(
      orphanPath,
      JSON.stringify({ pid: deadPid, token: orphanToken, startedAt: Date.now() })
    )
    let runtime: PythonRuntime | undefined
    try {
      runtime = await ensureFixtureRuntime(fixture)
      assert.equal(await lstat(orphanPath).catch(() => undefined), undefined)
      assert.equal(await lstat(fixedPath).catch(() => undefined), undefined)
    } finally {
      await runtime?.release()
      await fixture.cleanup()
    }
  })

  await t.test('live owner', async () => {
    const fixture = await createRuntimeFixture()
    const rootPath = expectedPaths(fixture.home).rootPath
    const liveToken = 'c'.repeat(32)
    const fixedPath = join(rootPath, 'provision.lock')
    const fixedRecord = JSON.stringify({
      pid: process.pid,
      token: liveToken,
      startedAt: Date.now()
    })
    await mkdir(rootPath, { recursive: true })
    await writeFile(fixedPath, fixedRecord)
    const controller = new AbortController()
    try {
      const pending = ensureFixtureRuntime(fixture, controller.signal)
      await waitUntil(async () => {
        const names = await readdir(rootPath)
        return names.some((name) => name.startsWith(`.provision-${process.pid}-`))
      }, 'contending provisioner did not publish its unique lock')
      controller.abort()
      await assert.rejects(
        pending,
        (error: unknown) => error instanceof Error && error.name === 'AbortError'
      )
      assert.equal(await readFile(fixedPath, 'utf8'), fixedRecord)
      await waitUntil(async () => {
        const names = await readdir(rootPath)
        return !names.some((name) => name.startsWith(`.provision-${process.pid}-`))
      }, 'contending provisioner leaked its unique lock')
    } finally {
      controller.abort()
      await fixture.cleanup()
    }
  })
})

test('keeps shared preparation alive for remaining waiters and cancels it for the last waiter', async () => {
  const shared = await createRuntimeFixture()
  const firstController = new AbortController()
  const started = deferred<void>()
  const release = deferred<void>()
  shared.broker.blockNextMatching = {
    match: (input) =>
      input.args.join('\0') === ['self', 'version', '--output-format', 'json'].join('\0'),
    started,
    release
  }

  try {
    const first = ensureFixtureRuntime(shared, firstController.signal)
    const second = ensureFixtureRuntime(shared)
    await started.promise
    await sleep(50)
    firstController.abort()
    await assert.rejects(
      first,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    )
    assert.equal(shared.broker.cancelledJobs, 0)
    release.resolve()
    const runtime = await second
    await runtime.release()
  } finally {
    release.resolve()
    await shared.cleanup()
  }

  const abandoned = await createRuntimeFixture()
  const onlyController = new AbortController()
  const abandonedStarted = deferred<void>()
  const neverReleased = deferred<void>()
  abandoned.broker.blockNextMatching = {
    match: (input) => input.args.includes('venv'),
    started: abandonedStarted,
    release: neverReleased
  }

  try {
    const pending = ensureFixtureRuntime(abandoned, onlyController.signal)
    await abandonedStarted.promise
    onlyController.abort()
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    )
    await waitUntil(
      async () => abandoned.broker.cancelledJobs === 1,
      'bootstrap job was not cancelled'
    )
    const rootPath = expectedPaths(abandoned.home).rootPath
    await waitUntil(async () => {
      const names = await readdir(rootPath).catch(() => [])
      return !names.some((name) => name === 'provision.lock' || name.startsWith('.provision-'))
    }, 'provision lock leaked after the final waiter aborted')
    assert.equal(
      await lstat(expectedPaths(abandoned.home).environmentPath).catch(() => undefined),
      undefined
    )
  } finally {
    await abandoned.cleanup()
  }
})

test('does not start shared preparation after cancellation during path creation', async () => {
  const fixture = await createRuntimeFixture()
  const started = deferred<void>()
  const release = deferred<void>()
  let abortChecks = 0
  const signal = {
    get aborted() {
      abortChecks += 1
      return abortChecks > 1
    }
  } as AbortSignal
  fixture.broker.blockNextMatching = {
    match: (input) =>
      input.args.join('\0') === ['self', 'version', '--output-format', 'json'].join('\0'),
    started,
    release
  }
  let preparationStarted = false

  try {
    await assert.rejects(
      ensureFixtureRuntime(fixture, signal),
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    )
    preparationStarted = await Promise.race([
      started.promise.then(() => true),
      sleep(100).then(() => false)
    ])
  } finally {
    release.resolve()
    if (preparationStarted) {
      const runtime = await ensureFixtureRuntime(fixture)
      await runtime.release()
    }
    await fixture.cleanup()
  }

  assert.equal(preparationStarted, false)
})

test('removes a published lease when post-write health validation is aborted', async () => {
  const fixture = await createRuntimeFixture()
  const paths = expectedPaths(fixture.home)
  const controller = new AbortController()
  const started = deferred<void>()
  const release = deferred<void>()
  let runtime: PythonRuntime | undefined

  try {
    runtime = await ensureFixtureRuntime(fixture)
    await runtime.release()
    runtime = undefined
    fixture.broker.blockNextMatching = {
      match: (input) => input.args[0] === '-I' && input.args[1] === '-c',
      remainingMatches: 3,
      started,
      release
    }

    const pending = ensureFixtureRuntime(fixture, controller.signal)
    await started.promise
    assert.equal(
      (await readdir(paths.leasesPath)).filter((name) => name.startsWith(`${process.pid}-`)).length,
      1
    )

    controller.abort()
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    )
    assert.equal(
      (await readdir(paths.leasesPath)).some((name) => name.startsWith(`${process.pid}-`)),
      false
    )
  } finally {
    release.resolve()
    await runtime?.release()
    await fixture.cleanup()
  }
})

test('publishes process leases, preserves live children, and cleans dead leases before repair', async () => {
  const fixture = await createRuntimeFixture()
  const paths = expectedPaths(fixture.home)
  let runtime: PythonRuntime | undefined
  let child: ChildProcess | undefined
  let releaseChildLease: (() => Promise<void>) | undefined

  try {
    runtime = await ensureFixtureRuntime(fixture)
    let leaseNames = await readdir(paths.leasesPath)
    assert.equal(leaseNames.filter((name) => name.startsWith(`${process.pid}-`)).length, 1)

    const preAborted = new AbortController()
    preAborted.abort()
    await assert.rejects(
      runtime.acquireProcessLease(process.pid, preAborted.signal),
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    )

    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    const childPid = child.pid
    assert.ok(childPid)
    releaseChildLease = await runtime.acquireProcessLease(childPid)
    leaseNames = await readdir(paths.leasesPath)
    assert.equal(leaseNames.filter((name) => name.startsWith(`${childPid}-`)).length, 1)

    await runtime.release()
    runtime = undefined
    leaseNames = await readdir(paths.leasesPath)
    assert.equal(
      leaseNames.some((name) => name.startsWith(`${process.pid}-`)),
      false
    )

    const deadPid = 2_147_483_647
    const deadToken = 'd'.repeat(32)
    const deadLease = join(paths.leasesPath, `${deadPid}-${deadToken}.json`)
    await writeFile(
      deadLease,
      JSON.stringify({ pid: deadPid, token: deadToken, startedAt: Date.now() })
    )
    fixture.broker.healthBasePrefixOverride = join(fixture.root, 'external-base')
    await mkdir(fixture.broker.healthBasePrefixOverride, { recursive: true })

    await assert.rejects(ensureFixtureRuntime(fixture), /still in use by another Yachiyo process/u)
    assert.equal(await lstat(deadLease).catch(() => undefined), undefined)
    assert.ok((await readdir(paths.leasesPath)).some((name) => name.startsWith(`${childPid}-`)))

    await terminateChild(child)
    child = undefined
    fixture.broker.healthBasePrefixOverride = undefined
    runtime = await ensureFixtureRuntime(fixture)
    assert.equal(
      (await readdir(paths.leasesPath)).some((name) => name.startsWith(`${deadPid}-`)),
      false
    )
    await releaseChildLease()
    await releaseChildLease()
    releaseChildLease = undefined
  } finally {
    if (child) await terminateChild(child)
    await releaseChildLease?.()
    await runtime?.release()
    await fixture.cleanup()
  }
})
