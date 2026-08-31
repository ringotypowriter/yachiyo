import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { StringDecoder } from 'node:string_decoder'
import { posix, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import type { ToolExecutionOptions } from 'ai'
import { z } from 'zod'

import { registerActiveChildProcess } from '../../app/domain/processes/activeProcessRegistry.ts'
import {
  forceTerminateChildProcess,
  gracefullyTerminateChildProcess,
  processTree,
  type ProcessTree
} from '../../app/domain/processes/processTree.ts'
import { signalProcessTree } from '../../app/domain/processes/killProcessTree.ts'
import type { PythonRuntime } from '../../services/python/managedPythonRuntime.ts'
import { isReplToolName } from './replNestedTools.ts'
import {
  isStrictJsonTree,
  type PyReplBridgeEndpoint,
  type PyReplToolBridge
} from './pyReplToolBridge.ts'

const PROTOCOL_VERSION = 1
const STARTUP_TIMEOUT_MS = 10_000
const INTERRUPT_GRACE_MS = 500
const TERMINATION_GRACE_MS = 1_000
const PROTOCOL_LINE_LIMIT_BYTES = 64 * 1024 * 1024
const CELL_PROTOCOL_LIMIT_BYTES = 64 * 1024 * 1024
const STDERR_TAIL_LIMIT_BYTES = 64 * 1024

const imageDataSchema = z.string().min(1).refine(isCanonicalBase64, 'Invalid base64 image data.')
const mimeBundleSchema = z
  .object({
    'text/plain': z.string().optional(),
    'text/markdown': z.string().optional(),
    'text/latex': z.string().optional(),
    'application/json': z.unknown().optional(),
    'image/png': imageDataSchema.optional(),
    'image/jpeg': imageDataSchema.optional()
  })
  .strict()
  .superRefine((bundle, context) => {
    if (Object.keys(bundle).length === 0) {
      context.addIssue({ code: 'custom', message: 'MIME bundle must not be empty.' })
    }
    if ('application/json' in bundle && !isStrictJsonTree(bundle['application/json'])) {
      context.addIssue({ code: 'custom', message: 'application/json must be a strict JSON tree.' })
    }
  })

const readyFrameSchema = z
  .object({
    type: z.literal('ready'),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/u)
  })
  .strict()

const startedFrameSchema = z.object({ type: z.literal('started'), id: z.string().min(1) }).strict()
const streamFrameSchema = z
  .object({
    type: z.union([z.literal('stdout'), z.literal('stderr')]),
    id: z.string().min(1),
    data: z.string()
  })
  .strict()
const displayFrameSchema = z
  .object({ type: z.literal('display'), id: z.string().min(1), bundle: mimeBundleSchema })
  .strict()
const resultFrameSchema = z
  .object({ type: z.literal('result'), id: z.string().min(1), bundle: mimeBundleSchema })
  .strict()
const errorFrameSchema = z
  .object({
    type: z.literal('error'),
    id: z.string().min(1),
    ename: z.string(),
    evalue: z.string(),
    traceback: z.array(z.string())
  })
  .strict()
const doneFrameSchema = z
  .object({
    type: z.literal('done'),
    id: z.string().min(1),
    status: z.union([z.literal('ok'), z.literal('error')]),
    cancelled: z.boolean(),
    resetRequired: z.boolean().optional(),
    resetReason: z.string().min(1).nullable().optional()
  })
  .strict()
  .superRefine((frame, context) => {
    const resetRequired = frame.resetRequired ?? false
    const resetReason = frame.resetReason ?? null
    if (resetRequired !== (resetReason !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'resetRequired and resetReason must describe the same state.'
      })
    }
  })

const cellFrameSchema = z.discriminatedUnion('type', [
  startedFrameSchema,
  streamFrameSchema,
  displayFrameSchema,
  resultFrameSchema,
  errorFrameSchema,
  doneFrameSchema
])

type MimeBundle = z.infer<typeof mimeBundleSchema>
type CellFrame = z.infer<typeof cellFrameSchema>
type DoneFrame = z.infer<typeof doneFrameSchema>

export type PyReplOutputEvent =
  | { type: 'stdout' | 'stderr'; data: string }
  | { type: 'display' | 'result'; bundle: MimeBundle }
  | { type: 'error'; ename: string; evalue: string; traceback: string[] }

export type PyReplFailureKind =
  | 'startup'
  | 'protocol'
  | 'process'
  | 'timeout'
  | 'abort'
  | 'disposed'

export interface PyReplExecutionResult {
  events: PyReplOutputEvent[]
  status: 'ok' | 'error' | 'cancelled' | 'failed'
  cancelled: boolean
  timedOut: boolean
  contextReset: boolean
  resetReason: string | undefined
  resetScope: 'before' | 'after' | undefined
  failureKind: PyReplFailureKind | undefined
  failure: string | undefined
}

export interface PyReplKernelCall {
  code: string
  cwd: string
  availableTools: readonly string[]
  reset: boolean
  timeoutMs: number
  signal?: AbortSignal
  executionOptions: ToolExecutionOptions
  resolveTool: (name: string) => unknown
}

interface SpawnPython {
  (
    executable: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }
  ): ChildProcessWithoutNullStreams
}

export interface PyReplKernelDependencies {
  spawn?: SpawnPython
  registerChild?: (child: ChildProcessWithoutNullStreams) => () => void
  processTree?: ProcessTree
  signalTree?: (pid: number, signal: NodeJS.Signals) => { delivered: boolean }
  platform?: NodeJS.Platform
  startupTimeoutMs?: number
  interruptGraceMs?: number
  terminationGraceMs?: number
  protocolLineLimitBytes?: number
  cellProtocolLimitBytes?: number
  stderrTailLimitBytes?: number
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
  settled(): boolean
}

interface ProtocolLineDecoder {
  rawParts: Buffer[]
  decodedParts: string[]
  decoder: StringDecoder
  bytes: number
}

interface ChildRecord {
  child: ChildProcessWithoutNullStreams
  unregister: () => void
  releaseLease: (() => Promise<void>) | undefined
  leasePromise: Promise<void>
  exit: Deferred<void>
  ready: Deferred<void>
  decoder: ProtocolLineDecoder
  stderrTail: Buffer
  readyReceived: boolean
  leaseAcquired: boolean
  expectedExit: boolean
  exited: boolean
  doNotReuse: boolean
  cleanupStarted: boolean
  termination: Promise<void> | undefined
  cleanup: Promise<void> | undefined
}

interface QueueEntry {
  request: PyReplKernelCall
  resolve(value: PyReplExecutionResult): void
  reject(error: unknown): void
  state: 'queued' | 'running' | 'settled'
  removeAbortListener: () => void
}

interface ActiveCell {
  entry: QueueEntry
  record: ChildRecord
  id: string
  events: PyReplOutputEvent[]
  completion: Deferred<PyReplExecutionResult>
  controller: AbortController
  started: boolean
  terminal: 'result' | 'error' | undefined
  done: boolean
  discarding: boolean
  protocolBytes: number
  timeout: NodeJS.Timeout | undefined
  removeAbortListener: () => void
}

export interface PyReplKernelOptions {
  runtime: PythonRuntime
  runnerPath: string
  initialCwd: string
  bridge: PyReplToolBridge
  dependencies?: PyReplKernelDependencies
}

export class PyReplKernel {
  private readonly runtime: PythonRuntime
  private readonly runnerPath: string
  private readonly initialCwd: string
  private readonly bridge: PyReplToolBridge
  private readonly spawn: SpawnPython
  private readonly registerChild: (child: ChildProcessWithoutNullStreams) => () => void
  private readonly tree: ProcessTree
  private readonly signalTree: (pid: number, signal: NodeJS.Signals) => { delivered: boolean }
  private readonly platform: NodeJS.Platform
  private readonly startupTimeoutMs: number
  private readonly interruptGraceMs: number
  private readonly terminationGraceMs: number
  private readonly protocolLineLimitBytes: number
  private readonly cellProtocolLimitBytes: number
  private readonly stderrTailLimitBytes: number
  private readonly lifecycle = new AbortController()
  private readonly queue: QueueEntry[] = []
  private child: ChildRecord | undefined
  private activeCell: ActiveCell | undefined
  private draining = false
  private disposed = false
  private pendingResetReason: string | undefined

  constructor(options: PyReplKernelOptions) {
    this.runtime = options.runtime
    this.runnerPath = options.runnerPath
    this.initialCwd = options.initialCwd
    this.bridge = options.bridge
    this.spawn = options.dependencies?.spawn ?? nodeSpawn
    this.registerChild = options.dependencies?.registerChild ?? registerActiveChildProcess
    this.tree = options.dependencies?.processTree ?? processTree
    this.signalTree = options.dependencies?.signalTree ?? signalProcessTree
    this.platform = options.dependencies?.platform ?? process.platform
    this.startupTimeoutMs = options.dependencies?.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
    this.interruptGraceMs = options.dependencies?.interruptGraceMs ?? INTERRUPT_GRACE_MS
    this.terminationGraceMs = options.dependencies?.terminationGraceMs ?? TERMINATION_GRACE_MS
    this.protocolLineLimitBytes =
      options.dependencies?.protocolLineLimitBytes ?? PROTOCOL_LINE_LIMIT_BYTES
    this.cellProtocolLimitBytes =
      options.dependencies?.cellProtocolLimitBytes ?? CELL_PROTOCOL_LIMIT_BYTES
    this.stderrTailLimitBytes =
      options.dependencies?.stderrTailLimitBytes ?? STDERR_TAIL_LIMIT_BYTES
  }

  execute(request: PyReplKernelCall): Promise<PyReplExecutionResult> {
    if (this.disposed) return Promise.reject(new Error('Python REPL kernel is disposed.'))
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      return Promise.reject(
        new Error('Python REPL timeout must be a positive integer number of milliseconds.')
      )
    }
    if (request.signal?.aborted) return Promise.reject(abortError())

    return new Promise<PyReplExecutionResult>((resolve, reject) => {
      const entry: QueueEntry = {
        request,
        resolve,
        reject,
        state: 'queued',
        removeAbortListener: () => undefined
      }
      const abortQueued = (): void => {
        if (entry.state !== 'queued') return
        entry.state = 'settled'
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        entry.removeAbortListener()
        reject(abortError())
      }
      request.signal?.addEventListener('abort', abortQueued, { once: true })
      entry.removeAbortListener = (): void =>
        request.signal?.removeEventListener('abort', abortQueued)
      this.queue.push(entry)
      void this.drainQueue()
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.abort()

    for (const entry of this.queue.splice(0)) {
      if (entry.state !== 'queued') continue
      entry.state = 'settled'
      entry.removeAbortListener()
      entry.reject(new Error('Python REPL kernel is disposed.'))
    }

    const active = this.activeCell
    if (active) {
      await this.interruptActive(active, 'disposed')
      return
    }
    const record = this.child
    if (record) await this.stopIdleChild(record)
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (!this.disposed) {
        const entry = this.queue.shift()
        if (!entry) break
        if (entry.state !== 'queued') continue
        entry.state = 'running'
        entry.removeAbortListener()
        try {
          const result = await this.runEntry(entry)
          entry.state = 'settled'
          entry.resolve(result)
        } catch (error) {
          entry.state = 'settled'
          entry.reject(error)
        }
      }
    } finally {
      this.draining = false
      if (!this.disposed && this.queue.some((entry) => entry.state === 'queued')) {
        void this.drainQueue()
      }
    }
  }

  private async runEntry(entry: QueueEntry): Promise<PyReplExecutionResult> {
    const { request } = entry
    let resetApplied = false
    if (request.reset) {
      const existing = this.child
      if (existing) await this.stopIdleChild(existing)
      resetApplied = true
    }

    let record: ChildRecord
    try {
      record = await this.ensureChild(request.signal)
    } catch (error) {
      if (request.signal?.aborted) throw abortError()
      if (this.disposed) throw new Error('Python REPL kernel is disposed.')
      return failedResult(
        'startup',
        withErrorDetail('Python REPL failed to start.', error),
        resetApplied
      )
    }
    const inheritedResetReason = resetApplied
      ? 'Python context was reset before execution.'
      : this.pendingResetReason
    if (request.signal?.aborted) throw abortError()

    const availableTools = normalizeAvailableToolNames(request.availableTools)
    const id = randomUUID()
    const completion = createDeferred<PyReplExecutionResult>()
    const controller = new AbortController()
    const active: ActiveCell = {
      entry,
      record,
      id,
      events: [],
      completion,
      controller,
      started: false,
      terminal: undefined,
      done: false,
      discarding: false,
      protocolBytes: 0,
      timeout: undefined,
      removeAbortListener: () => undefined
    }
    this.activeCell = active
    this.bridge.activateCell({
      cellId: id,
      cwd: request.cwd,
      executionOptions: request.executionOptions,
      resolveTool: request.resolveTool,
      availableTools,
      signal: controller.signal
    })

    const abortActive = (): void => {
      void this.interruptActive(active, 'abort')
    }
    request.signal?.addEventListener('abort', abortActive, { once: true })
    active.removeAbortListener = (): void =>
      request.signal?.removeEventListener('abort', abortActive)
    active.timeout = setTimeout(() => {
      void this.interruptActive(active, 'timeout')
    }, request.timeoutMs)

    try {
      if (request.signal?.aborted) {
        await this.interruptActive(active, 'abort')
      } else {
        const encoded = encodeExecuteRequest(id, request, availableTools)
        if (encoded.length > this.protocolLineLimitBytes) {
          await this.failActive(
            active,
            'protocol',
            'Python REPL request exceeds the 64 MiB protocol-line limit.'
          )
        } else {
          await writeToChild(record.child, encoded)
        }
      }
      const result = await completion.promise
      if (inheritedResetReason && this.pendingResetReason === inheritedResetReason) {
        this.pendingResetReason = undefined
      }
      if (record.doNotReuse && !record.exited) {
        await this.terminateRecord(record, false)
      }
      if (inheritedResetReason && !result.contextReset) {
        return {
          ...result,
          contextReset: true,
          resetReason: inheritedResetReason,
          resetScope: 'before'
        }
      }
      return result
    } catch (error) {
      await this.failActive(
        active,
        'process',
        withErrorDetail('Python REPL request failed.', error)
      )
      return await completion.promise
    } finally {
      clearTimeout(active.timeout)
      active.removeAbortListener()
      this.bridge.deactivateCell(id)
      controller.abort()
      if (this.activeCell === active) this.activeCell = undefined
    }
  }

  private async ensureChild(signal?: AbortSignal): Promise<ChildRecord> {
    const startupSignal = signal
      ? AbortSignal.any([signal, this.lifecycle.signal])
      : this.lifecycle.signal
    throwIfAborted(startupSignal)
    const existing = this.child
    if (existing && !existing.exited && !existing.doNotReuse) return existing
    if (existing && !existing.exited) await this.terminateRecord(existing, false)
    throwIfAborted(startupSignal)

    const endpoint = await this.bridge.endpoint()
    throwIfAborted(startupSignal)
    const child = this.spawn(this.runtime.pythonPath, ['-I', '-u', this.runnerPath], {
      cwd: this.initialCwd,
      env: createChildEnvironment(this.runtime.env, endpoint, this.runtime.uvPath, this.platform),
      detached: this.platform !== 'win32',
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const record = this.createChildRecord(child)
    this.child = record
    if (child.pid !== undefined) {
      record.leasePromise = this.acquireChildLease(record, child.pid, startupSignal)
    }
    this.attachChild(record)

    if (child.pid === undefined) {
      await this.terminateRecord(record, false)
      throw new Error('Python REPL child did not expose a process id.')
    }

    const abortStartup = createDeferred<void>()
    const startupTimeout = new AbortController()
    const onAbort = (): void => abortStartup.reject(abortError())
    startupSignal.addEventListener('abort', onAbort, { once: true })
    if (startupSignal.aborted) onAbort()
    try {
      await Promise.race([
        record.ready.promise,
        delay(this.startupTimeoutMs, undefined, { signal: startupTimeout.signal }).then(() => {
          throw new Error(
            `Python REPL startup timed out after ${this.startupTimeoutMs / 1_000} seconds.`
          )
        }),
        abortStartup.promise
      ])
      if (record.expectedExit || record.exited || record.doNotReuse) {
        throw new Error('Python REPL exited while completing startup.')
      }
      return record
    } catch (error) {
      await this.terminateRecord(record, false)
      const diagnostics = record.stderrTail.toString('utf8').trim()
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${diagnostics ? `\nRunner diagnostics:\n${diagnostics}` : ''}`
      )
    } finally {
      startupTimeout.abort()
      startupSignal.removeEventListener('abort', onAbort)
    }
  }

  private createChildRecord(child: ChildProcessWithoutNullStreams): ChildRecord {
    return {
      child,
      unregister: this.registerChild(child),
      releaseLease: undefined,
      leasePromise: Promise.resolve(),
      exit: createDeferred<void>(),
      ready: createDeferred<void>(),
      decoder: createProtocolDecoder(),
      stderrTail: Buffer.alloc(0),
      readyReceived: false,
      leaseAcquired: false,
      expectedExit: false,
      exited: false,
      doNotReuse: false,
      cleanupStarted: false,
      cleanup: undefined,
      termination: undefined
    }
  }

  private attachChild(record: ChildRecord): void {
    record.child.stdout.on('data', (chunk: Buffer | string) => {
      this.consumeProtocolBytes(record, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    record.child.stdout.on('end', () => {
      if (!record.expectedExit && record.decoder.bytes > 0) {
        void this.breakProtocol(record, 'Python REPL protocol ended with a truncated frame.')
      }
    })
    record.child.stderr.on('data', (chunk: Buffer | string) => {
      record.stderrTail = appendTail(
        record.stderrTail,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        this.stderrTailLimitBytes
      )
    })
    record.child.once('error', (error) => {
      if (record.expectedExit) return
      if (!record.ready.settled()) {
        record.ready.reject(error)
        return
      }
      const active = this.activeCell
      if (active?.record === record) {
        void this.failActive(
          active,
          'process',
          this.withRunnerDiagnostics(record, withErrorDetail('Python REPL process failed.', error))
        )
      } else {
        void this.breakProtocol(record, withErrorDetail('Python REPL process failed.', error))
      }
    })
    record.child.once('exit', (code, signal) => {
      record.exited = true
      record.exit.resolve()
      if (this.child === record) this.child = undefined
      if (!record.expectedExit) {
        const detail = `Python REPL process exited unexpectedly (code ${String(code)}, signal ${String(signal)}).`
        if (!record.ready.settled()) record.ready.reject(new Error(detail))
        const active = this.activeCell
        if (active?.record === record && !active.completion.settled()) {
          void this.failActive(active, 'process', this.withRunnerDiagnostics(record, detail))
        } else if (record.readyReceived && record.leaseAcquired) {
          this.pendingResetReason = detail
        }
      }
      void this.cleanupChildRecord(record)
    })
  }

  private async acquireChildLease(
    record: ChildRecord,
    pid: number,
    startupSignal: AbortSignal
  ): Promise<void> {
    try {
      const release = await this.runtime.acquireProcessLease(pid, startupSignal)
      record.releaseLease = release
      record.leaseAcquired = true
      if (record.exited) void this.cleanupChildRecord(record)
      else this.acceptReady(record)
    } catch (error) {
      if (!record.ready.settled()) record.ready.reject(error)
      if (!record.exited) {
        void this.terminateRecord(record, false).catch((terminationError) => {
          console.warn('[yachiyo][py-repl] failed to terminate an unattested child', {
            pid: record.child.pid,
            error: terminationError
          })
        })
      }
    }
  }

  private acceptReady(record: ChildRecord): void {
    if (record.readyReceived && record.leaseAcquired && !record.ready.settled()) {
      record.ready.resolve()
    }
  }

  private consumeProtocolBytes(record: ChildRecord, chunk: Buffer): void {
    if (record.exited || record.expectedExit) return
    const active = this.activeCell
    if (active?.record === record) {
      active.protocolBytes += chunk.length
      if (active.protocolBytes > this.cellProtocolLimitBytes) {
        void this.breakProtocol(record, 'Python REPL cell exceeded the aggregate protocol limit.')
        return
      }
    }

    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      if (!this.appendProtocolPart(record, part)) return
      if (newline < 0) return
      record.decoder.bytes += 1
      if (record.decoder.bytes > this.protocolLineLimitBytes) {
        void this.breakProtocol(record, 'Python REPL emitted an oversized protocol line.')
        return
      }
      const rawLine = Buffer.concat(record.decoder.rawParts, record.decoder.bytes - 1)
      const decodedLine = `${record.decoder.decodedParts.join('')}${record.decoder.decoder.end()}`
      record.decoder = createProtocolDecoder()
      if (!isUtf8(rawLine)) {
        void this.breakProtocol(record, 'Python REPL emitted invalid UTF-8.')
        return
      }
      this.consumeProtocolLine(record, decodedLine)
      if (record.expectedExit) return
      offset = newline + 1
    }
  }

  private appendProtocolPart(record: ChildRecord, part: Buffer): boolean {
    record.decoder.bytes += part.length
    if (record.decoder.bytes > this.protocolLineLimitBytes) {
      void this.breakProtocol(record, 'Python REPL emitted an oversized protocol line.')
      return false
    }
    if (part.length > 0) {
      record.decoder.rawParts.push(part)
      record.decoder.decodedParts.push(record.decoder.decoder.write(part))
    }
    return true
  }

  private consumeProtocolLine(record: ChildRecord, line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      void this.breakProtocol(record, 'Python REPL emitted invalid JSON.')
      return
    }

    if (!record.readyReceived) {
      const ready = readyFrameSchema.safeParse(value)
      if (!ready.success || ready.data.pythonVersion !== this.runtime.version) {
        void this.breakProtocol(record, 'Python REPL emitted an invalid ready frame.')
        return
      }
      record.readyReceived = true
      this.acceptReady(record)
      return
    }

    const active = this.activeCell
    if (!active || active.record !== record) {
      void this.breakProtocol(record, 'Python REPL emitted a frame while no cell was active.')
      return
    }
    if (active.discarding) return

    const parsed = cellFrameSchema.safeParse(value)
    if (!parsed.success) {
      void this.breakProtocol(record, 'Python REPL emitted an invalid cell frame.')
      return
    }
    this.consumeCellFrame(active, parsed.data)
  }

  private consumeCellFrame(active: ActiveCell, frame: CellFrame): void {
    if (frame.id !== active.id) {
      void this.breakProtocol(active.record, 'Python REPL emitted a frame for the wrong cell.')
      return
    }
    if (frame.type === 'started') {
      if (active.started || active.terminal || active.done) {
        void this.breakProtocol(
          active.record,
          'Python REPL emitted an out-of-sequence started frame.'
        )
        return
      }
      active.started = true
      return
    }
    if (frame.type === 'done') {
      if (!active.started || active.done) {
        void this.breakProtocol(active.record, 'Python REPL emitted an out-of-sequence done frame.')
        return
      }
      this.consumeDoneFrame(active, frame)
      return
    }
    if (!active.started || active.terminal || active.done) {
      void this.breakProtocol(active.record, 'Python REPL emitted an out-of-sequence cell frame.')
      return
    }

    switch (frame.type) {
      case 'stdout':
      case 'stderr':
        active.events.push({ type: frame.type, data: frame.data })
        break
      case 'display':
        active.events.push({ type: 'display', bundle: frame.bundle })
        break
      case 'result':
        active.terminal = 'result'
        active.events.push({ type: 'result', bundle: frame.bundle })
        break
      case 'error':
        active.terminal = 'error'
        active.events.push({
          type: 'error',
          ename: frame.ename,
          evalue: frame.evalue,
          traceback: frame.traceback
        })
        break
    }
  }

  private consumeDoneFrame(active: ActiveCell, frame: DoneFrame): void {
    if (
      active.done ||
      (frame.status === 'ok' && active.terminal === 'error') ||
      (frame.status === 'error' && active.terminal !== 'error')
    ) {
      void this.breakProtocol(
        active.record,
        'Python REPL done frame contradicts the terminal frame.'
      )
      return
    }
    const resetRequired = frame.resetRequired ?? false
    const resetReason = frame.resetReason ?? null
    active.done = true
    if (resetRequired) active.record.doNotReuse = true
    const result: PyReplExecutionResult = {
      events: active.events,
      status: frame.status,
      cancelled: frame.cancelled,
      timedOut: false,
      contextReset: resetRequired,
      resetReason: resetReason ?? undefined,
      resetScope: resetRequired ? 'after' : undefined,
      failureKind: undefined,
      failure: undefined
    }
    queueMicrotask(() => {
      if (!active.discarding) active.completion.resolve(result)
    })
  }

  private async interruptActive(
    active: ActiveCell,
    kind: 'timeout' | 'abort' | 'disposed'
  ): Promise<void> {
    if (active.completion.settled() || active.discarding) return
    active.discarding = true
    active.controller.abort()
    this.bridge.deactivateCell(active.id)
    let terminationError: unknown
    try {
      await this.terminateRecord(active.record, kind === 'timeout' || kind === 'abort')
    } catch (error) {
      terminationError = error
    }
    const baseMessage =
      kind === 'timeout'
        ? 'Python REPL execution timed out.'
        : kind === 'abort'
          ? 'Python REPL execution was aborted.'
          : 'Python REPL kernel was disposed.'
    const message = terminationError
      ? withErrorDetail(`${baseMessage} Process termination failed.`, terminationError)
      : baseMessage
    active.completion.resolve({
      events: active.events,
      status: 'cancelled',
      cancelled: true,
      timedOut: kind === 'timeout',
      contextReset: true,
      resetReason: message,
      resetScope: 'after',
      failureKind: kind,
      failure: message
    })
  }

  private async failActive(
    active: ActiveCell,
    kind: Extract<PyReplFailureKind, 'protocol' | 'process'>,
    message: string
  ): Promise<void> {
    if (active.completion.settled() || active.discarding) return
    active.discarding = true
    active.controller.abort()
    this.bridge.deactivateCell(active.id)
    try {
      await this.terminateRecord(active.record, false)
    } catch (error) {
      message = withErrorDetail(`${message} Process termination failed.`, error)
    }
    await this.settleActiveFailure(active, kind, message)
  }

  private async settleActiveFailure(
    active: ActiveCell,
    kind: Extract<PyReplFailureKind, 'protocol' | 'process'>,
    message: string
  ): Promise<void> {
    active.completion.resolve({
      events: active.events,
      status: 'failed',
      cancelled: false,
      timedOut: false,
      contextReset: true,
      resetReason: message,
      resetScope: 'after',
      failureKind: kind,
      failure: message
    })
  }

  private async breakProtocol(record: ChildRecord, message: string): Promise<void> {
    if (record.expectedExit) return
    record.doNotReuse = true
    const active = this.activeCell
    if (active?.record === record) {
      await this.failActive(active, 'protocol', this.withRunnerDiagnostics(record, message))
      return
    }
    if (record.ready.settled()) this.pendingResetReason = message
    if (!record.ready.settled())
      record.ready.reject(new Error(this.withRunnerDiagnostics(record, message)))
    await this.terminateRecord(record, false)
  }

  private async stopIdleChild(record: ChildRecord): Promise<void> {
    record.termination ??= this.stopIdleChildOnce(record)
    await record.termination
    if (record.exited) await this.cleanupChildRecord(record)
  }

  private async stopIdleChildOnce(record: ChildRecord): Promise<void> {
    if (record.exited) return
    record.doNotReuse = true
    record.expectedExit = true
    try {
      await writeToChild(record.child, Buffer.from('{"type":"exit"}\n', 'utf8'))
      record.child.stdin.end()
    } catch {
      // The process may have exited between the state check and the write.
    }
    if (!(await waitForExit(record, this.interruptGraceMs))) {
      gracefullyTerminateChildProcess(record.child, this.tree)
      if (!(await waitForExit(record, this.terminationGraceMs))) {
        await this.forceTerminateRecord(record)
      }
    }
  }

  private async terminateRecord(record: ChildRecord, interruptFirst: boolean): Promise<void> {
    record.termination ??= this.terminateRecordOnce(record, interruptFirst)
    await record.termination
    if (record.exited) await this.cleanupChildRecord(record)
  }

  private async terminateRecordOnce(record: ChildRecord, interruptFirst: boolean): Promise<void> {
    if (record.exited) return
    record.expectedExit = true
    record.doNotReuse = true
    const pid = record.child.pid
    if (interruptFirst && this.platform !== 'win32' && pid !== undefined) {
      this.signalTree(pid, 'SIGINT')
      if (await waitForExit(record, this.interruptGraceMs)) return
    }
    gracefullyTerminateChildProcess(record.child, this.tree)
    if (await waitForExit(record, this.terminationGraceMs)) return
    await this.forceTerminateRecord(record)
  }

  private async forceTerminateRecord(record: ChildRecord): Promise<void> {
    const treeResult = forceTerminateChildProcess(record.child, this.tree)
    if (await waitForExit(record, this.terminationGraceMs)) return

    let directError: unknown
    if (this.platform === 'win32') {
      try {
        if (!record.child.kill('SIGKILL')) {
          directError = new Error('child.kill() returned false.')
        }
      } catch (error) {
        directError = error
      }
      if (await waitForExit(record, this.terminationGraceMs)) return
    }

    const details = [
      treeResult.error,
      directError === undefined ? undefined : `Direct termination failed: ${String(directError)}`
    ].filter((detail): detail is string => detail !== undefined)
    throw new Error(
      `Python REPL process did not exit after forced termination.${details.length > 0 ? ` ${details.join(' ')}` : ''}`
    )
  }

  private cleanupChildRecord(record: ChildRecord): Promise<void> {
    record.cleanup ??= this.cleanupChildRecordOnce(record)
    return record.cleanup
  }

  private async cleanupChildRecordOnce(record: ChildRecord): Promise<void> {
    if (record.cleanupStarted) return
    record.cleanupStarted = true
    await record.leasePromise.catch(() => undefined)
    try {
      record.unregister()
    } catch (error) {
      console.warn('[yachiyo][py-repl] failed to unregister child process', {
        pid: record.child.pid,
        error
      })
    }
    try {
      await record.releaseLease?.()
    } catch (error) {
      console.warn('[yachiyo][py-repl] failed to release child runtime lease', {
        pid: record.child.pid,
        error
      })
    }
  }

  private withRunnerDiagnostics(record: ChildRecord, message: string): string {
    const diagnostics = record.stderrTail.toString('utf8').trim()
    return diagnostics ? `${message}\nRunner diagnostics:\n${diagnostics}` : message
  }
}

export function createPyReplKernel(options: PyReplKernelOptions): PyReplKernel {
  return new PyReplKernel(options)
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: unknown) => void
  let isSettled = false
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: (value) => {
      if (isSettled) return
      isSettled = true
      resolvePromise(value)
    },
    reject: (error) => {
      if (isSettled) return
      isSettled = true
      rejectPromise(error)
    },
    settled: () => isSettled
  }
}

function createProtocolDecoder(): ProtocolLineDecoder {
  return { rawParts: [], decodedParts: [], decoder: new StringDecoder('utf8'), bytes: 0 }
}

function normalizeAvailableToolNames(names: readonly string[]): string[] {
  return [...new Set(names)].filter((name) => !isReplToolName(name)).sort()
}

function createChildEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  endpoint: PyReplBridgeEndpoint,
  uvPath: string,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  if (typeof endpoint.url !== 'string') {
    throw new Error('Python REPL bridge URL is missing.')
  }
  let bridgeUrl: URL
  try {
    bridgeUrl = new URL(endpoint.url)
  } catch {
    throw new Error('Python REPL bridge URL is malformed.')
  }
  if (
    bridgeUrl.protocol !== 'http:' ||
    bridgeUrl.hostname !== '127.0.0.1' ||
    bridgeUrl.port === '' ||
    bridgeUrl.pathname !== '/tool' ||
    bridgeUrl.username !== '' ||
    bridgeUrl.password !== '' ||
    bridgeUrl.search !== '' ||
    bridgeUrl.hash !== ''
  ) {
    throw new Error('Python REPL bridge URL must be an authenticated loopback endpoint.')
  }
  if (typeof endpoint.token !== 'string' || !/^[a-f0-9]{64}$/u.test(endpoint.token)) {
    throw new Error('Python REPL bridge token is malformed.')
  }
  const isAbsoluteUvPath =
    platform === 'win32' ? win32.isAbsolute(uvPath) : posix.isAbsolute(uvPath)
  if (!isAbsoluteUvPath) throw new Error('Python REPL uv path must be absolute.')

  const environment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(([key]) => !key.startsWith('YACHIYO_PY_REPL_'))
  )
  return {
    ...environment,
    YACHIYO_PY_REPL_PARENT_PID: String(process.pid),
    YACHIYO_PY_REPL_BRIDGE_URL: endpoint.url,
    YACHIYO_PY_REPL_BRIDGE_TOKEN: endpoint.token,
    YACHIYO_PY_REPL_UV_PATH: uvPath
  }
}
function encodeExecuteRequest(
  id: string,

  request: PyReplKernelCall,
  availableTools: readonly string[]
): Buffer {
  const body = JSON.stringify({
    type: 'execute',
    id,
    code: request.code,
    cwd: request.cwd,
    availableTools
  })
  return Buffer.from(`${body}\n`, 'utf8')
}

async function writeToChild(child: ChildProcessWithoutNullStreams, data: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(data, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function waitForExit(record: ChildRecord, timeoutMs: number): Promise<boolean> {
  if (record.exited) return true
  return await Promise.race([
    record.exit.promise.then(() => true),
    delay(timeoutMs).then(() => false)
  ])
}

function appendTail(existing: Buffer, chunk: Buffer, limit: number): Buffer {
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit)
  const keep = Math.min(existing.length, limit - chunk.length)
  return Buffer.concat([existing.subarray(existing.length - keep), chunk], keep + chunk.length)
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return !value.slice(0, value.length - padding).includes('=')
}

function failedResult(
  kind: Extract<PyReplFailureKind, 'startup'>,
  message: string,
  contextReset: boolean
): PyReplExecutionResult {
  return {
    events: [],
    status: 'failed',
    cancelled: false,
    timedOut: false,
    contextReset,
    resetReason: contextReset ? message : undefined,
    resetScope: contextReset ? 'before' : undefined,
    failureKind: kind,
    failure: message
  }
}

function withErrorDetail(message: string, error: unknown): string {
  return `${message} ${error instanceof Error ? error.message : String(error)}`
}

function abortError(): Error {
  const error = new Error('Python REPL call was aborted before execution.')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}
