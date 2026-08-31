import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import type { ToolExecutionOptions } from 'ai'

import type {
  ProcessTree,
  ProcessTreeTerminationResult
} from '../../app/domain/processes/processTree.ts'
import { createProcessTree } from '../../app/domain/processes/processTree.ts'
import type { PythonRuntime } from '../../services/python/managedPythonRuntime.ts'
import {
  createPyReplKernel,
  type PyReplKernelCall,
  type PyReplKernelDependencies
} from './pyReplKernel.ts'
import type {
  PyReplBridgeCellContext,
  PyReplBridgeEndpoint,
  PyReplToolBridge
} from './pyReplToolBridge.ts'

const READY_FRAME = {
  type: 'ready',
  protocolVersion: 1,
  pythonVersion: '3.12.14'
} as const
const BRIDGE_TOKEN = 'a'.repeat(64)

interface ProtocolRequest {
  type: string
  id?: string
  code?: string
  cwd?: string
  availableTools?: string[]
}

type RequestHandler = (child: FakeChild, request: ProtocolRequest) => void | Promise<void>

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: ProtocolRequest[] = []
  readonly killSignals: Array<NodeJS.Signals | number> = []
  readonly index: number
  pid: number | undefined
  private input = ''
  private exited = false
  private readonly onRequest: RequestHandler

  constructor(index: number, pid: number | undefined, onRequest: RequestHandler) {
    super()
    this.index = index
    this.pid = pid
    this.onRequest = onRequest
    this.stdin.on('data', (chunk: Buffer) => this.consumeInput(chunk))
  }

  sendFrame(frame: unknown): void {
    this.sendRaw(`${JSON.stringify(frame)}\n`)
  }

  sendFrames(...frames: unknown[]): void {
    this.sendRaw(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`)
  }

  sendRaw(value: string | Buffer): void {
    if (!this.exited) this.stdout.write(value)
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    this.stdout.end()
    this.stderr.end()
    this.stdin.end()
    this.emit('exit', code, signal)
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killSignals.push(signal)
    this.exit(null, typeof signal === 'string' ? signal : null)
    return true
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams
  }

  private consumeInput(chunk: Buffer): void {
    this.input += chunk.toString('utf8')
    while (true) {
      const newline = this.input.indexOf('\n')
      if (newline < 0) return
      const line = this.input.slice(0, newline)
      this.input = this.input.slice(newline + 1)
      const request = JSON.parse(line) as ProtocolRequest
      this.requests.push(request)
      void Promise.resolve(this.onRequest(this, request)).catch((error) =>
        this.emit('error', error)
      )
    }
  }
}

interface SpawnCall {
  executable: string
  args: readonly string[]
  options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }
}

interface KernelHarnessOptions {
  endpoint?: PyReplBridgeEndpoint
  uvPath?: string
  runtimeVersion?: string
  runtimeEnvironment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  pid?: number | undefined
  emitReady?: (child: FakeChild) => void
  onRequest?: RequestHandler
  acquireLease?: (pid: number, signal: AbortSignal) => Promise<() => Promise<void> | void>
  terminationBehavior?: 'graceful' | 'force' | 'never'
  signalBehavior?: 'exit' | 'ignore'
  dependencies?: Partial<PyReplKernelDependencies>
}

interface KernelHarness {
  kernel: ReturnType<typeof createPyReplKernel>
  children: FakeChild[]
  spawnCalls: SpawnCall[]
  activations: PyReplBridgeCellContext[]
  deactivations: string[]
  terminationSteps: string[]
  signalSteps: Array<{ pid: number; signal: NodeJS.Signals }>
  registrationCount(): number
  unregistrationCount(): number
  releaseCount(): number
}

function successfulResponse(child: FakeChild, request: ProtocolRequest, value = 'ok'): void {
  assert.equal(request.type, 'execute')
  assert.ok(request.id)
  child.sendFrames(
    { type: 'started', id: request.id },
    { type: 'result', id: request.id, bundle: { 'text/plain': value } },
    { type: 'done', id: request.id, status: 'ok', cancelled: false }
  )
}

function createHarness(options: KernelHarnessOptions = {}): KernelHarness {
  const children: FakeChild[] = []
  const spawnCalls: SpawnCall[] = []
  const activations: PyReplBridgeCellContext[] = []
  const deactivations: string[] = []
  const terminationSteps: string[] = []
  const signalSteps: Array<{ pid: number; signal: NodeJS.Signals }> = []
  let registrations = 0
  let unregistrations = 0
  let releases = 0

  const onRequest: RequestHandler =
    options.onRequest ??
    ((child, request) => {
      if (request.type === 'exit') child.exit()
      else successfulResponse(child, request)
    })

  const spawn = (
    executable: string,
    args: readonly string[],
    spawnOptions: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }
  ): ChildProcessWithoutNullStreams => {
    spawnCalls.push({ executable, args, options: spawnOptions })
    const child = new FakeChild(children.length, options.pid ?? 4_000 + children.length, onRequest)
    children.push(child)
    queueMicrotask(() => {
      if (options.emitReady) options.emitReady(child)
      else child.sendFrame({ ...READY_FRAME, pythonVersion: options.runtimeVersion ?? '3.12.14' })
    })
    return child.asChildProcess()
  }

  const successfulTermination = (): ProcessTreeTerminationResult => ({
    alreadyExited: false,
    delivered: true,
    error: undefined
  })
  const tree: ProcessTree = {
    platform: options.platform ?? 'darwin',
    gracefullyTerminate: (pid) => {
      terminationSteps.push(`graceful:${pid}`)
      if ((options.terminationBehavior ?? 'graceful') === 'graceful') {
        children.find((child) => child.pid === pid)?.exit(null, 'SIGTERM')
      }
      return successfulTermination()
    },
    forceTerminate: (pid) => {
      terminationSteps.push(`force:${pid}`)
      if (options.terminationBehavior !== 'never') {
        children.find((child) => child.pid === pid)?.exit(null, 'SIGKILL')
      }
      return successfulTermination()
    }
  }
  const signalTree = (pid: number, signal: NodeJS.Signals): { delivered: boolean } => {
    signalSteps.push({ pid, signal })
    if (options.signalBehavior === 'exit') {
      children.find((child) => child.pid === pid)?.exit(null, signal)
    }
    return { delivered: true }
  }

  const runtime = {
    kind: 'managed',
    pythonPath: '/private/python/bin/python',
    uvPath: options.uvPath ?? '/private/bin/uv',
    env: options.runtimeEnvironment ?? {
      HOME: '/private/home',
      PATH: '/private/bin',
      YACHIYO_PY_REPL_STALE: 'must-not-leak'
    },
    version: options.runtimeVersion ?? '3.12.14',
    acquireProcessLease: async (pid: number, signal: AbortSignal) => {
      const release = options.acquireLease
        ? await options.acquireLease(pid, signal)
        : async (): Promise<void> => undefined
      return async (): Promise<void> => {
        releases += 1
        await release()
      }
    }
  } as unknown as PythonRuntime

  const endpoint = options.endpoint ?? {
    url: 'http://127.0.0.1:43123/tool',
    token: BRIDGE_TOKEN
  }
  const bridge = {
    endpoint: async (): Promise<PyReplBridgeEndpoint> => endpoint,
    activateCell: (context: PyReplBridgeCellContext): void => {
      activations.push(context)
    },
    deactivateCell: (cellId: string): void => {
      deactivations.push(cellId)
    }
  } as unknown as PyReplToolBridge

  const dependencies: PyReplKernelDependencies = {
    spawn,
    registerChild: () => {
      registrations += 1
      let active = true
      return (): void => {
        if (!active) return
        active = false
        unregistrations += 1
      }
    },
    processTree: tree,
    signalTree,
    platform: options.platform ?? 'darwin',
    startupTimeoutMs: 50,
    interruptGraceMs: 2,
    terminationGraceMs: 2,
    protocolLineLimitBytes: 1024 * 1024,
    cellProtocolLimitBytes: 2 * 1024 * 1024,
    stderrTailLimitBytes: 1024,
    ...options.dependencies
  }

  return {
    kernel: createPyReplKernel({
      runtime,
      runnerPath: '/app/pyReplRunner.py',
      initialCwd: '/workspace',
      bridge,
      dependencies
    }),
    children,
    spawnCalls,
    activations,
    deactivations,
    terminationSteps,
    signalSteps,
    registrationCount: () => registrations,
    unregistrationCount: () => unregistrations,
    releaseCount: () => releases
  }
}

function kernelCall(overrides: Partial<PyReplKernelCall> = {}): PyReplKernelCall {
  return {
    code: '1 + 1',
    cwd: '/workspace/cell',
    availableTools: ['write', 'pyRepl', 'read', 'write', 'jsRepl'],
    reset: false,
    timeoutMs: 500,
    executionOptions: {} as ToolExecutionOptions,
    resolveTool: () => undefined,
    ...overrides
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Condition was not reached.')
}

async function disposeHarness(harness: KernelHarness): Promise<void> {
  await harness.kernel.dispose().catch(() => undefined)
}

test('kernel decodes fragmented ready and batched cell frames while preserving strict order', async () => {
  const ready = Buffer.from(`${JSON.stringify(READY_FRAME)}\n`)
  const harness = createHarness({
    emitReady: (child) => {
      child.sendRaw(ready.subarray(0, 7))
      child.sendRaw(ready.subarray(7))
    },
    onRequest: (child, request) => {
      assert.ok(request.id)
      const encoded = Buffer.from(
        [
          { type: 'started', id: request.id },
          { type: 'stdout', id: request.id, data: 'héllo' },
          { type: 'display', id: request.id, bundle: { 'application/json': { answer: 42 } } },
          { type: 'stderr', id: request.id, data: 'warning' },
          { type: 'result', id: request.id, bundle: { 'text/latex': 'x^2' } },
          { type: 'done', id: request.id, status: 'ok', cancelled: false }
        ]
          .map((frame) => JSON.stringify(frame))
          .join('\n') + '\n'
      )
      const unicodeOffset = encoded.indexOf(Buffer.from('é'))
      child.sendRaw(encoded.subarray(0, unicodeOffset + 1))
      child.sendRaw(encoded.subarray(unicodeOffset + 1))
    }
  })

  try {
    const result = await harness.kernel.execute(kernelCall())
    assert.deepEqual(result, {
      events: [
        { type: 'stdout', data: 'héllo' },
        { type: 'display', bundle: { 'application/json': { answer: 42 } } },
        { type: 'stderr', data: 'warning' },
        { type: 'result', bundle: { 'text/latex': 'x^2' } }
      ],
      status: 'ok',
      cancelled: false,
      timedOut: false,
      contextReset: false,
      resetReason: undefined,
      resetScope: undefined,
      failureKind: undefined,
      failure: undefined
    })

    const request = harness.children[0]?.requests[0]
    assert.deepEqual(Object.keys(request ?? {}).sort(), [
      'availableTools',
      'code',
      'cwd',
      'id',
      'type'
    ])
    assert.deepEqual(request?.availableTools, ['read', 'write'])
    assert.equal(request?.code, '1 + 1')
    assert.equal(request?.cwd, '/workspace/cell')

    const spawn = harness.spawnCalls[0]
    assert.equal(spawn?.executable, '/private/python/bin/python')
    assert.deepEqual(spawn?.args, ['-I', '-u', '/app/pyReplRunner.py'])
    assert.equal(spawn?.options.cwd, '/workspace')
    assert.equal(spawn?.options.shell, false)
    assert.equal(spawn?.options.detached, true)
    assert.deepEqual(
      Object.keys(spawn?.options.env ?? {})
        .filter((key) => key.startsWith('YACHIYO_PY_REPL_'))
        .sort(),
      [
        'YACHIYO_PY_REPL_BRIDGE_TOKEN',
        'YACHIYO_PY_REPL_BRIDGE_URL',
        'YACHIYO_PY_REPL_PARENT_PID',
        'YACHIYO_PY_REPL_UV_PATH'
      ]
    )
    assert.equal(spawn?.options.env?.YACHIYO_PY_REPL_PARENT_PID, String(process.pid))
    assert.equal(spawn?.options.env?.YACHIYO_PY_REPL_BRIDGE_URL, 'http://127.0.0.1:43123/tool')
    assert.equal(spawn?.options.env?.YACHIYO_PY_REPL_BRIDGE_TOKEN, BRIDGE_TOKEN)
    assert.equal(spawn?.options.env?.YACHIYO_PY_REPL_UV_PATH, '/private/bin/uv')
  } finally {
    await disposeHarness(harness)
  }
})

test('kernel refuses malformed transport values before spawning a child', async (context) => {
  const cases: Array<{ name: string; options: KernelHarnessOptions; message: RegExp }> = [
    {
      name: 'missing URL',
      options: {
        endpoint: { url: undefined, token: BRIDGE_TOKEN } as unknown as PyReplBridgeEndpoint
      },
      message: /bridge URL is missing/u
    },
    {
      name: 'non-loopback URL',
      options: { endpoint: { url: 'http://localhost:1234/tool', token: BRIDGE_TOKEN } },
      message: /authenticated loopback endpoint/u
    },
    {
      name: 'malformed token',
      options: { endpoint: { url: 'http://127.0.0.1:1234/tool', token: 'ABC' } },
      message: /bridge token is malformed/u
    },
    {
      name: 'relative uv path',
      options: { uvPath: 'bin/uv' },
      message: /uv path must be absolute/u
    }
  ]

  for (const item of cases) {
    await context.test(item.name, async () => {
      const harness = createHarness(item.options)
      try {
        const result = await harness.kernel.execute(kernelCall())
        assert.equal(result.status, 'failed')
        assert.equal(result.failureKind, 'startup')
        assert.match(result.failure ?? '', item.message)
        assert.equal(harness.spawnCalls.length, 0)
      } finally {
        await disposeHarness(harness)
      }
    })
  }
})

test('kernel accepts the selected workspace runtime version', async () => {
  const harness = createHarness({ runtimeVersion: '3.11.14' })
  try {
    const result = await harness.kernel.execute(kernelCall())
    assert.equal(result.status, 'ok')
    assert.equal(harness.spawnCalls.length, 1)
  } finally {
    await disposeHarness(harness)
  }
})

test('kernel requires exact ready protocol and selected Python versions with no extra fields', async (context) => {
  const invalidReadyFrames: Array<{ name: string; value: unknown | string }> = [
    { name: 'invalid JSON', value: '{not-json' },
    { name: 'wrong protocol', value: { ...READY_FRAME, protocolVersion: 2 } },
    { name: 'wrong Python', value: { ...READY_FRAME, pythonVersion: '3.12.13' } },
    { name: 'extra field', value: { ...READY_FRAME, extra: true } },
    { name: 'cell frame before ready', value: { type: 'started', id: 'early' } }
  ]

  for (const item of invalidReadyFrames) {
    await context.test(item.name, async () => {
      const harness = createHarness({
        emitReady: (child) => {
          child.sendRaw(
            typeof item.value === 'string' ? `${item.value}\n` : `${JSON.stringify(item.value)}\n`
          )
        }
      })
      try {
        const result = await harness.kernel.execute(kernelCall())
        assert.equal(result.status, 'failed')
        assert.equal(result.failureKind, 'startup')
        assert.match(result.failure ?? '', /failed to start/u)
        assert.equal(harness.children[0]?.requests.length, 0)
      } finally {
        await disposeHarness(harness)
      }
    })
  }
})

test('kernel reports startup timeout when no ready frame arrives', async () => {
  const harness = createHarness({
    emitReady: () => undefined,
    dependencies: { startupTimeoutMs: 5 }
  })
  try {
    const result = await harness.kernel.execute(kernelCall())
    assert.equal(result.status, 'failed')
    assert.equal(result.failureKind, 'startup')
    assert.match(result.failure ?? '', /startup timed out/u)
    assert.deepEqual(harness.terminationSteps, ['graceful:4000'])
  } finally {
    await disposeHarness(harness)
  }
})

test('kernel waits for the process lease before accepting ready and releases it exactly once', async () => {
  let publishLease!: () => void
  const leasePublished = new Promise<void>((resolve) => {
    publishLease = resolve
  })
  const harness = createHarness({
    acquireLease: async () => {
      await leasePublished
      return async (): Promise<void> => undefined
    }
  })

  try {
    const execution = harness.kernel.execute(kernelCall())
    await waitUntil(() => harness.children.length === 1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(harness.children[0]?.requests.length, 0)

    publishLease()
    assert.equal((await execution).status, 'ok')
    assert.equal(harness.releaseCount(), 0)
    await harness.kernel.dispose()
    await harness.kernel.dispose()
    assert.equal(harness.releaseCount(), 1)
    assert.equal(harness.registrationCount(), 1)
    assert.equal(harness.unregistrationCount(), 1)
  } finally {
    await disposeHarness(harness)
  }
})

test('startup abort rejects immediately and terminates the unattested child', async () => {
  const controller = new AbortController()
  const harness = createHarness({
    acquireLease: async (_pid, signal) =>
      await new Promise<() => Promise<void>>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('lease aborted')
            error.name = 'AbortError'
            reject(error)
          },
          { once: true }
        )
      })
  })

  try {
    const execution = harness.kernel.execute(kernelCall({ signal: controller.signal }))
    await waitUntil(() => harness.children.length === 1)
    controller.abort()
    await assert.rejects(execution, { name: 'AbortError' })
    assert.deepEqual(harness.terminationSteps, ['graceful:4000'])
    assert.equal(harness.releaseCount(), 0)
    assert.equal(harness.unregistrationCount(), 1)
  } finally {
    await disposeHarness(harness)
  }
})

test('kernel enforces request-line, output-line, and aggregate cell limits independently', async (context) => {
  await context.test('request line', async () => {
    const harness = createHarness({ dependencies: { protocolLineLimitBytes: 128 } })
    try {
      const result = await harness.kernel.execute(kernelCall({ code: 'x'.repeat(256) }))
      assert.equal(result.failureKind, 'protocol')
      assert.match(result.failure ?? '', /request exceeds/u)
      assert.equal(harness.children[0]?.requests.length, 0)
    } finally {
      await disposeHarness(harness)
    }
  })

  await context.test('output line', async () => {
    const harness = createHarness({
      dependencies: { protocolLineLimitBytes: 256 },
      onRequest: (child, request) => {
        assert.ok(request.id)
        child.sendFrame({ type: 'started', id: request.id })
        child.sendFrame({ type: 'stdout', id: request.id, data: 'x'.repeat(400) })
      }
    })
    try {
      const result = await harness.kernel.execute(kernelCall())
      assert.equal(result.failureKind, 'protocol')
      assert.match(result.failure ?? '', /oversized protocol line/u)
    } finally {
      await disposeHarness(harness)
    }
  })

  await context.test('aggregate output', async () => {
    const harness = createHarness({
      dependencies: { protocolLineLimitBytes: 256, cellProtocolLimitBytes: 230 },
      onRequest: (child, request) => {
        assert.ok(request.id)
        child.sendFrame({ type: 'started', id: request.id })
        child.sendFrame({ type: 'stdout', id: request.id, data: 'a'.repeat(80) })
        child.sendFrame({ type: 'stdout', id: request.id, data: 'b'.repeat(80) })
      }
    })
    try {
      const result = await harness.kernel.execute(kernelCall())
      assert.equal(result.failureKind, 'protocol')
      assert.match(result.failure ?? '', /aggregate protocol limit/u)
    } finally {
      await disposeHarness(harness)
    }
  })
})

test('kernel rejects wrong ids, invalid sequencing, malformed frames, and unsafe done states', async (context) => {
  const cases: Array<{
    name: string
    respond(child: FakeChild, id: string): void
  }> = [
    {
      name: 'wrong id',
      respond: (child) => child.sendFrame({ type: 'started', id: 'wrong-id' })
    },
    {
      name: 'missing started',
      respond: (child, id) => child.sendFrame({ type: 'stdout', id, data: 'early' })
    },
    {
      name: 'duplicate started',
      respond: (child, id) => child.sendFrames({ type: 'started', id }, { type: 'started', id })
    },
    {
      name: 'duplicate done',
      respond: (child, id) =>
        child.sendFrames(
          { type: 'started', id },
          { type: 'done', id, status: 'ok', cancelled: false },
          { type: 'done', id, status: 'ok', cancelled: false }
        )
    },
    {
      name: 'error status without error frame',
      respond: (child, id) =>
        child.sendFrames(
          { type: 'started', id },
          { type: 'done', id, status: 'error', cancelled: false }
        )
    },
    {
      name: 'ok status after error frame',
      respond: (child, id) =>
        child.sendFrames(
          { type: 'started', id },
          { type: 'error', id, ename: 'ValueError', evalue: 'bad', traceback: [] },
          { type: 'done', id, status: 'ok', cancelled: false }
        )
    },
    {
      name: 'inconsistent reset fields',
      respond: (child, id) =>
        child.sendFrames(
          { type: 'started', id },
          {
            type: 'done',
            id,
            status: 'ok',
            cancelled: false,
            resetRequired: true,
            resetReason: null
          }
        )
    },
    {
      name: 'unsafe JSON MIME value',
      respond: (child, id) =>
        child.sendFrames(
          { type: 'started', id },
          {
            type: 'result',
            id,
            bundle: { 'application/json': { unsafe: 9_007_199_254_740_992 } }
          }
        )
    },
    {
      name: 'non-canonical image data',
      respond: (child, id) =>
        child.sendFrames(
          { type: 'started', id },
          { type: 'result', id, bundle: { 'image/png': 'abc' } }
        )
    },
    {
      name: 'unknown frame',
      respond: (child, id) => child.sendFrames({ type: 'started', id }, { type: 'mystery', id })
    },
    {
      name: 'extra frame field',
      respond: (child, id) =>
        child.sendFrames(
          { type: 'started', id },
          { type: 'stdout', id, data: 'value', extra: true }
        )
    },
    {
      name: 'malformed cell JSON',
      respond: (child, id) => {
        child.sendFrame({ type: 'started', id })
        child.sendRaw('{bad-json\n')
      }
    }
  ]

  for (const item of cases) {
    await context.test(item.name, async () => {
      const harness = createHarness({
        onRequest: (child, request) => {
          assert.ok(request.id)
          item.respond(child, request.id)
        }
      })
      try {
        const result = await harness.kernel.execute(kernelCall())
        assert.equal(result.status, 'failed')
        assert.equal(result.failureKind, 'protocol')
        assert.equal(result.contextReset, true)
      } finally {
        await disposeHarness(harness)
      }
    })
  }
})

test('kernel rejects bytes after done and never reuses that child', async () => {
  const harness = createHarness({
    onRequest: (child, request) => {
      if (request.type === 'exit') {
        child.exit()
        return
      }
      assert.ok(request.id)
      if (child.index === 0) {
        child.sendFrames(
          { type: 'started', id: request.id },
          { type: 'done', id: request.id, status: 'ok', cancelled: false },
          { type: 'stdout', id: request.id, data: 'too late' }
        )
      } else {
        successfulResponse(child, request, 'fresh child')
      }
    }
  })

  try {
    const first = await harness.kernel.execute(kernelCall())
    assert.deepEqual(first.events, [])
    assert.equal(first.status, 'failed')
    assert.equal(first.failureKind, 'protocol')
    const second = await harness.kernel.execute(kernelCall({ code: 'second' }))
    assert.equal(second.status, 'ok')
    assert.deepEqual(second.events, [{ type: 'result', bundle: { 'text/plain': 'fresh child' } }])
    assert.equal(harness.children.length, 2)
    assert.deepEqual(harness.terminationSteps, ['graceful:4000'])
  } finally {
    await disposeHarness(harness)
  }
})

test('kernel carries valid reset-required done state and replaces the child', async () => {
  const harness = createHarness({
    onRequest: (child, request) => {
      if (request.type === 'exit') {
        child.exit()
        return
      }
      assert.ok(request.id)
      if (child.index === 0) {
        child.sendFrames(
          { type: 'started', id: request.id },
          {
            type: 'done',
            id: request.id,
            status: 'ok',
            cancelled: false,
            resetRequired: true,
            resetReason: 'background thread remained active'
          }
        )
      } else {
        successfulResponse(child, request)
      }
    }
  })

  try {
    const first = await harness.kernel.execute(kernelCall())
    assert.equal(first.contextReset, true)
    assert.equal(first.resetScope, 'after')
    assert.equal(first.resetReason, 'background thread remained active')
    assert.equal((await harness.kernel.execute(kernelCall())).status, 'ok')
    assert.equal(harness.children.length, 2)
  } finally {
    await disposeHarness(harness)
  }
})

test('bounded startup diagnostics retain only the configured stderr tail', async () => {
  const harness = createHarness({
    dependencies: { stderrTailLimitBytes: 8 },
    emitReady: (child) => {
      child.stderr.write('abcdefgh12345678')
      child.sendRaw('{invalid\n')
    }
  })

  try {
    const result = await harness.kernel.execute(kernelCall())
    assert.equal(result.failureKind, 'startup')
    assert.match(result.failure ?? '', /Runner diagnostics:\n12345678/u)
    assert.doesNotMatch(result.failure ?? '', /abcdefgh/u)
  } finally {
    await disposeHarness(harness)
  }
})

test('unexpected active-process exit fails one call and the queued call recovers on a fresh child', async () => {
  const harness = createHarness({
    onRequest: (child, request) => {
      assert.ok(request.id)
      if (child.index === 0) {
        child.sendFrame({ type: 'started', id: request.id })
        child.stderr.write('fatal runner detail')
        child.exit(7)
      } else if (request.type === 'exit') {
        child.exit()
      } else {
        successfulResponse(child, request, 'recovered')
      }
    }
  })

  try {
    const firstExecution = harness.kernel.execute(kernelCall({ code: 'crash' }))
    const secondExecution = harness.kernel.execute(kernelCall({ code: 'recover' }))
    const [first, second] = await Promise.all([firstExecution, secondExecution])
    assert.equal(first.failureKind, 'process')
    assert.match(first.failure ?? '', /code 7/u)
    assert.match(first.failure ?? '', /fatal runner detail/u)
    assert.equal(second.status, 'ok')
    assert.deepEqual(second.events, [{ type: 'result', bundle: { 'text/plain': 'recovered' } }])
    assert.equal(harness.children.length, 2)
  } finally {
    await disposeHarness(harness)
  }
})

test('a queued abort is removed immediately and never reaches the child', async () => {
  let activeId: string | undefined
  const harness = createHarness({
    onRequest: (child, request) => {
      if (request.type === 'exit') {
        child.exit()
        return
      }
      assert.ok(request.id)
      activeId = request.id
      child.sendFrame({ type: 'started', id: request.id })
    }
  })
  const queuedController = new AbortController()

  try {
    const active = harness.kernel.execute(kernelCall({ code: 'active' }))
    await waitUntil(() => activeId !== undefined)
    const queued = harness.kernel.execute(
      kernelCall({ code: 'queued', signal: queuedController.signal })
    )
    queuedController.abort()
    await assert.rejects(queued, { name: 'AbortError' })
    assert.equal(harness.children[0]?.requests.length, 1)

    harness.children[0]?.sendFrame({
      type: 'done',
      id: activeId,
      status: 'ok',
      cancelled: false
    })
    assert.equal((await active).status, 'ok')
    assert.equal(harness.children[0]?.requests.length, 1)
  } finally {
    await disposeHarness(harness)
  }
})

test('idle disposal uses the exit protocol while active disposal terminates the tree', async (context) => {
  await context.test('idle child', async () => {
    const harness = createHarness()
    try {
      assert.equal((await harness.kernel.execute(kernelCall())).status, 'ok')
      await harness.kernel.dispose()
      assert.deepEqual(
        harness.children[0]?.requests.map((request) => request.type),
        ['execute', 'exit']
      )
      assert.deepEqual(harness.terminationSteps, [])
      assert.equal(harness.releaseCount(), 1)
    } finally {
      await disposeHarness(harness)
    }
  })

  await context.test('active child', async () => {
    const harness = createHarness({
      onRequest: (child, request) => {
        assert.ok(request.id)
        child.sendFrame({ type: 'started', id: request.id })
      }
    })
    try {
      const execution = harness.kernel.execute(kernelCall())
      await waitUntil(() => harness.children[0]?.requests.length === 1)
      await harness.kernel.dispose()
      const result = await execution
      assert.equal(result.failureKind, 'disposed')
      assert.equal(result.status, 'cancelled')
      assert.deepEqual(
        harness.children[0]?.requests.map((request) => request.type),
        ['execute']
      )
      assert.deepEqual(harness.terminationSteps, ['graceful:4000'])
    } finally {
      await disposeHarness(harness)
    }
  })
})

test('POSIX timeout escalates interrupt to graceful and forced tree termination', async () => {
  const harness = createHarness({
    terminationBehavior: 'force',
    signalBehavior: 'ignore',
    dependencies: { interruptGraceMs: 1, terminationGraceMs: 1 },
    onRequest: (child, request) => {
      assert.ok(request.id)
      child.sendFrame({ type: 'started', id: request.id })
    }
  })

  try {
    const result = await harness.kernel.execute(kernelCall({ timeoutMs: 5 }))
    assert.equal(result.failureKind, 'timeout')
    assert.equal(result.timedOut, true)
    assert.equal(result.contextReset, true)
    assert.deepEqual(harness.signalSteps, [{ pid: 4000, signal: 'SIGINT' }])
    assert.deepEqual(harness.terminationSteps, ['graceful:4000', 'force:4000'])
  } finally {
    await disposeHarness(harness)
  }
})

test('Windows timeout skips SIGINT and escalates tree termination without shell fallback', async () => {
  const harness = createHarness({
    platform: 'win32',
    uvPath: 'C:\\private\\bin\\uv.exe',
    terminationBehavior: 'force',
    dependencies: { interruptGraceMs: 1, terminationGraceMs: 1 },
    onRequest: (child, request) => {
      assert.ok(request.id)
      child.sendFrame({ type: 'started', id: request.id })
    }
  })

  try {
    const result = await harness.kernel.execute(kernelCall({ timeoutMs: 5 }))
    assert.equal(result.failureKind, 'timeout')
    assert.deepEqual(harness.signalSteps, [])
    assert.deepEqual(harness.terminationSteps, ['graceful:4000', 'force:4000'])
    assert.equal(harness.spawnCalls[0]?.options.shell, false)
    assert.equal(harness.spawnCalls[0]?.options.detached, false)
  } finally {
    await disposeHarness(harness)
  }
})

test('Windows abort recovers when taskkill does not report the child exit', async () => {
  const controller = new AbortController()
  const harness = createHarness({
    platform: 'win32',
    uvPath: 'C:\\private\\bin\\uv.exe',
    terminationBehavior: 'never',
    dependencies: { terminationGraceMs: 1 },
    onRequest: (child, request) => {
      assert.ok(request.id)
      if (child.index === 0) {
        child.sendFrame({ type: 'started', id: request.id })
      } else {
        successfulResponse(child, request, '42')
      }
    }
  })

  try {
    const execution = harness.kernel.execute(kernelCall({ signal: controller.signal }))
    await waitUntil(() => harness.children[0]?.requests.length === 1)
    controller.abort(new Error('test cancellation'))

    const cancelled = await execution
    assert.equal(cancelled.failureKind, 'abort')
    assert.equal(cancelled.contextReset, true)
    assert.deepEqual(harness.terminationSteps, ['graceful:4000', 'force:4000'])
    assert.deepEqual(harness.children[0]?.killSignals, ['SIGKILL'])

    const recovered = await harness.kernel.execute(kernelCall({ code: '7 * 6' }))
    assert.equal(recovered.status, 'ok')
    assert.deepEqual(recovered.events, [{ type: 'result', bundle: { 'text/plain': '42' } }])
    assert.equal(harness.children.length, 2)
  } finally {
    await disposeHarness(harness)
  }
})

test('Windows process tree maps graceful and forced termination to taskkill /T and /T /F', () => {
  const calls: Array<{ command: string; args: string[]; windowsHide: boolean | undefined }> = []
  const tree = createProcessTree({
    platform: 'win32',
    isProcessRunning: () => true,
    spawnSync: (command, args, options) => {
      calls.push({ command, args, windowsHide: options.windowsHide })
      return { status: 0, stderr: '' }
    }
  })

  assert.equal(tree.gracefullyTerminate(123).delivered, true)
  assert.equal(tree.forceTerminate(123).delivered, true)
  assert.deepEqual(calls, [
    { command: 'taskkill.exe', args: ['/PID', '123', '/T'], windowsHide: true },
    { command: 'taskkill.exe', args: ['/PID', '123', '/T', '/F'], windowsHide: true }
  ])
})
