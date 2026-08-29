import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

import { registerActiveChildProcess } from '../../app/domain/processes/activeProcessRegistry.ts'
import { forceTerminateChildProcess } from '../../app/domain/processes/processTree.ts'
import { resolveBundledExecutable } from '../nativeExecutable.ts'
import { resolveHostShellRuntime, type ShellRuntime } from '../../runtime/shell/shellRuntime.ts'
import { PROCESS_HOST_PROTOCOL_VERSION } from './processHostProtocol.generated.ts'
import type { ClientMessage, ServerMessage } from './processHostProtocol.generated.ts'
import type {
  ProcessBroker,
  ProcessJob,
  ProcessJobOutcome,
  ProcessJobResult,
  ProcessOutputBatch,
  ProcessOutputChunk,
  ProcessOutputStream,
  StartProcessJobInput
} from './processBroker.ts'

const START_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 2_000
const MAX_PENDING_OUTPUT_BYTES = 64 * 1024
const WINDOWS_SHELL_ENVIRONMENT_KEYS: Readonly<Record<string, true>> = {
  path: true,
  home: true,
  msystem: true,
  chere_invoking: true,
  msys2_path_type: true
}

interface PendingRequest {
  resolve: (message: Extract<ServerMessage, { type: 'started' | 'ack' }>) => void
  reject: (error: unknown) => void
}
interface PendingOutputBatch {
  batch: ProcessOutputBatch
  bytes: number
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isOutputStream(value: string): value is ProcessOutputStream {
  return value === 'stdout' || value === 'stderr'
}

function environmentRecord(
  shellEnvironment: NodeJS.ProcessEnv,
  jobEnvironment: NodeJS.ProcessEnv
): Record<string, string> {
  const output: Record<string, string> = {}
  const canonicalNames = new Map<string, string>()
  const windows = process.platform === 'win32'
  for (const [name, value] of Object.entries(shellEnvironment)) {
    if (value === undefined) continue
    const canonicalName = windows ? name.toLowerCase() : name
    canonicalNames.set(canonicalName, name)
    output[name] = value
  }
  for (const [name, value] of Object.entries(jobEnvironment)) {
    const canonicalName = windows ? name.toLowerCase() : name
    if (windows && WINDOWS_SHELL_ENVIRONMENT_KEYS[canonicalName]) continue
    const previousName = canonicalNames.get(canonicalName)
    if (previousName) delete output[previousName]
    if (value === undefined) {
      canonicalNames.delete(canonicalName)
      continue
    }
    canonicalNames.set(canonicalName, name)
    output[name] = value
  }
  return output
}

export class NativeProcessBrokerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'NativeProcessBrokerError'
    this.code = code
  }
}

class NativeProcessJob implements ProcessJob {
  readonly id: string
  readonly logPath: string
  private readonly broker: NativeProcessBroker
  private readonly listeners = new Set<(batch: ProcessOutputBatch) => void>()
  private readonly terminal = Promise.withResolvers<ProcessJobResult>()
  private readonly outcome = Promise.withResolvers<ProcessJobOutcome>()
  private pendingOutput: PendingOutputBatch[] = []
  private pendingOutputBytes = 0
  private expectedSequence = 0
  private outcomeSettled = false
  private terminalSettled = false
  private processId: number | undefined

  constructor(broker: NativeProcessBroker, id: string, logPath: string) {
    this.broker = broker
    this.id = id
    this.logPath = logPath
    // A job exposes two independently optional wait surfaces. Attach observers so a
    // broker failure is not reported as unhandled when a caller only consumes one.
    void this.terminal.promise.catch(() => {})
    void this.outcome.promise.catch(() => {})
  }

  get pid(): number {
    if (this.processId === undefined) {
      throw new Error(`Process job ${this.id} has not started.`)
    }
    return this.processId
  }

  markStarted(pid: number): void {
    if (this.processId !== undefined) {
      throw new Error(`Process job ${this.id} reported startup twice.`)
    }
    this.processId = pid
  }

  onOutput(listener: (batch: ProcessOutputBatch) => void): () => void {
    if (!this.terminalSettled) this.listeners.add(listener)
    if (this.pendingOutput.length > 0) {
      const pending = this.pendingOutput
      this.pendingOutput = []
      this.pendingOutputBytes = 0
      for (const entry of pending) listener(entry.batch)
    }
    return this.terminalSettled ? () => {} : () => this.listeners.delete(listener)
  }

  waitForOutcome(): Promise<ProcessJobOutcome> {
    return this.outcome.promise
  }

  wait(): Promise<ProcessJobResult> {
    return this.terminal.promise
  }

  cancel(): void {
    if (this.terminalSettled) return
    void this.broker.cancelJob(this.id).catch((error) => this.fail(error))
  }

  deliverOutput(
    sequence: number,
    chunks: ProcessOutputChunk[],
    truncated: boolean,
    totalBytes: number
  ): void {
    if (sequence !== this.expectedSequence) {
      this.fail(
        new NativeProcessBrokerError(
          'outputSequenceGap',
          `Process job ${this.id} expected output sequence ${this.expectedSequence}, received ${sequence}.`
        )
      )
      return
    }
    this.expectedSequence++
    const batch = { sequence, chunks, truncated, totalBytes }
    if (this.listeners.size > 0) {
      for (const listener of this.listeners) listener(batch)
      return
    }

    const bytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0)
    this.pendingOutput.push({ batch, bytes })
    this.pendingOutputBytes += bytes
    let droppedOutput = false
    while (this.pendingOutputBytes > MAX_PENDING_OUTPUT_BYTES && this.pendingOutput.length > 1) {
      const removed = this.pendingOutput.shift()
      if (!removed) break
      this.pendingOutputBytes -= removed.bytes
      droppedOutput = true
    }
    if (droppedOutput) this.pendingOutput[0].batch.truncated = true
  }

  markTimedOut(): void {
    if (this.outcomeSettled) return
    this.outcomeSettled = true
    this.outcome.resolve({ kind: 'timed-out' })
  }

  markExited(result: ProcessJobResult): void {
    if (this.terminalSettled) return
    this.terminalSettled = true
    this.terminal.resolve(result)
    if (!this.outcomeSettled) {
      this.outcomeSettled = true
      this.outcome.resolve({ kind: 'exited', result })
    }
    this.listeners.clear()
  }

  fail(error: unknown): void {
    if (this.terminalSettled) return
    const failure = toError(error)
    this.terminalSettled = true
    this.terminal.reject(failure)
    if (!this.outcomeSettled) {
      this.outcomeSettled = true
      this.outcome.reject(failure)
    }
    this.listeners.clear()
    this.pendingOutput = []
    this.pendingOutputBytes = 0
  }
}

export interface NativeProcessBrokerOptions {
  binaryPath?: string
  shellRuntime?: ShellRuntime
  spawnProcess?: typeof spawn
}

export class NativeProcessBroker implements ProcessBroker {
  private readonly binaryPathOverride?: string
  private readonly shellRuntime: ShellRuntime
  private readonly spawnProcess: typeof spawn
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private ready: PromiseWithResolvers<void> | null = null
  private readonly requests = new Map<string, PendingRequest>()
  private readonly jobs = new Map<string, NativeProcessJob>()
  private writeChain: Promise<void> = Promise.resolve()
  private closing = false

  constructor(options: NativeProcessBrokerOptions = {}) {
    this.binaryPathOverride = options.binaryPath
    this.shellRuntime =
      options.shellRuntime ??
      resolveHostShellRuntime({
        env: process.env,
        readLoginShellEnvironment: () => process.env
      })
    this.spawnProcess = options.spawnProcess ?? spawn
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.closing) {
      return Promise.reject(
        new NativeProcessBrokerError('brokerClosed', 'The native process broker is closed.')
      )
    }

    const ready = Promise.withResolvers<void>()
    this.ready = ready
    const child = this.spawnProcess(this.binaryPathOverride ?? resolveProcessHostBinary(), [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }) as ChildProcessWithoutNullStreams
    this.child = child
    registerActiveChildProcess(child)

    child.stdout.setEncoding('utf8')
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.handleLine(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (line) console.error(`[process-host] ${line}`)
      }
    })
    let lifecycleSettled = false
    const resetAfterStop = (reason: unknown): void => {
      if (lifecycleSettled) return
      lifecycleSettled = true
      lines.close()
      this.failBroker(reason)
      if (this.child === child) {
        this.child = null
        this.startPromise = null
        this.ready = null
      }
    }
    const stoppedReason = (code: number | null, signal: NodeJS.Signals | null): Error =>
      this.closing
        ? new NativeProcessBrokerError('brokerClosed', 'The native process broker stopped.')
        : new NativeProcessBrokerError(
            'brokerExited',
            `The native process broker exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`
          )
    child.once('error', resetAfterStop)
    child.once('exit', (code, signal) => resetAfterStop(stoppedReason(code, signal)))
    child.once('close', (code, signal) => resetAfterStop(stoppedReason(code, signal)))

    const timeout = setTimeout(() => {
      ready.reject(
        new NativeProcessBrokerError(
          'startTimeout',
          `The native process broker did not become ready within ${START_TIMEOUT_MS} ms.`
        )
      )
      const result = forceTerminateChildProcess(child)
      if (!result.delivered && !result.alreadyExited) {
        console.error('[yachiyo][process-host] failed to terminate startup timeout', result.error)
      }
    }, START_TIMEOUT_MS)
    timeout.unref?.()

    this.startPromise = ready.promise.finally(() => clearTimeout(timeout))
    return this.startPromise
  }

  async startJob(input: StartProcessJobInput): Promise<ProcessJob> {
    await this.start()
    if (this.jobs.has(input.id)) {
      throw new NativeProcessBrokerError(
        'duplicateJob',
        `A process job with id ${input.id} is already active.`
      )
    }

    const command = this.shellRuntime.command(input.command, { cwd: input.cwd })
    const job = new NativeProcessJob(this, input.id, input.logPath)
    this.jobs.set(input.id, job)
    const requestId = randomUUID()
    const message: ClientMessage = {
      type: 'start',
      requestId,
      jobId: input.id,
      executable: command.executable,
      args: command.args,
      cwd: input.cwd,
      env: environmentRecord(command.options.env, input.env),
      logPath: input.logPath,
      timeoutMs:
        input.timeoutSeconds === undefined ? null : Math.round(input.timeoutSeconds * 1000),
      keepRunningOnTimeout: input.keepRunningOnTimeout,
      retainLog: input.retainLog,
      spillThresholdChars: input.spillThresholdChars
    }

    try {
      const response = await this.request(message)
      if (response.type !== 'started') {
        throw new NativeProcessBrokerError(
          'protocolViolation',
          `Expected a started response for process job ${input.id}.`
        )
      }
      job.markStarted(response.pid)
      return job
    } catch (error) {
      this.jobs.delete(input.id)
      job.fail(error)
      void job.wait().catch(() => {})
      void job.waitForOutcome().catch(() => {})
      throw error
    }
  }

  async cancelJob(jobId: string): Promise<boolean> {
    if (!this.child) return false
    const response = await this.request({
      type: 'cancel',
      requestId: randomUUID(),
      jobId
    })
    if (response.type !== 'ack') {
      throw new NativeProcessBrokerError(
        'protocolViolation',
        `Expected an acknowledgement while cancelling process job ${jobId}.`
      )
    }
    return response.accepted
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const child = this.child
    if (!child) return

    try {
      const response = await this.request({ type: 'shutdown', requestId: randomUUID() })
      if (response.type !== 'ack' || !response.accepted) {
        throw new NativeProcessBrokerError(
          'shutdownRejected',
          'The native process broker rejected shutdown.'
        )
      }
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error
    }

    const exited = Promise.withResolvers<void>()
    if (child.exitCode !== null || child.signalCode !== null) {
      exited.resolve()
    } else {
      const timeout = setTimeout(() => {
        const result = forceTerminateChildProcess(child)
        if (!result.delivered && !result.alreadyExited) {
          console.error('[yachiyo][process-host] failed to force shutdown', result.error)
        }
        exited.resolve()
      }, SHUTDOWN_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(timeout)
        exited.resolve()
      })
    }
    await exited.promise
  }

  private request(
    message: ClientMessage
  ): Promise<Extract<ServerMessage, { type: 'started' | 'ack' }>> {
    const requestId = message.requestId
    if (this.requests.has(requestId)) {
      return Promise.reject(
        new NativeProcessBrokerError('duplicateRequest', `Duplicate request id: ${requestId}`)
      )
    }

    const response = Promise.withResolvers<Extract<ServerMessage, { type: 'started' | 'ack' }>>()
    this.requests.set(requestId, { resolve: response.resolve, reject: response.reject })
    void this.write(message).catch((error) => {
      this.requests.delete(requestId)
      response.reject(error)
    })
    return response.promise
  }

  private write(message: ClientMessage): Promise<void> {
    const child = this.child
    if (!child || child.stdin.destroyed) {
      return Promise.reject(
        new NativeProcessBrokerError(
          'brokerUnavailable',
          'The native process broker is unavailable.'
        )
      )
    }
    const write = async (): Promise<void> => {
      const encoded = `${JSON.stringify(message)}\n`
      if (!child.stdin.write(encoded, 'utf8')) {
        const writable = Promise.withResolvers<void>()
        const onDrain = (): void => {
          cleanup()
          writable.resolve()
        }
        const onError = (error: Error): void => {
          cleanup()
          writable.reject(error)
        }
        const cleanup = (): void => {
          child.stdin.off('drain', onDrain)
          child.stdin.off('error', onError)
        }
        child.stdin.once('drain', onDrain)
        child.stdin.once('error', onError)
        await writable.promise
      }
    }
    this.writeChain = this.writeChain.then(write, write)
    return this.writeChain
  }

  private handleLine(line: string): void {
    let message: ServerMessage
    try {
      message = JSON.parse(line) as ServerMessage
    } catch (error) {
      this.failBroker(
        new NativeProcessBrokerError(
          'invalidMessage',
          `The native process broker emitted invalid JSON: ${toError(error).message}`
        )
      )
      return
    }

    switch (message.type) {
      case 'ready':
        if (message.protocolVersion !== PROCESS_HOST_PROTOCOL_VERSION) {
          this.failBroker(
            new NativeProcessBrokerError(
              'protocolVersionMismatch',
              `Process host protocol ${message.protocolVersion} does not match runtime protocol ${PROCESS_HOST_PROTOCOL_VERSION}.`
            )
          )
          return
        }
        this.ready?.resolve()
        return
      case 'started':
      case 'ack': {
        const pending = this.requests.get(message.requestId)
        if (!pending) {
          this.failBroker(
            new NativeProcessBrokerError(
              'unknownRequest',
              `The native process broker responded to unknown request ${message.requestId}.`
            )
          )
          return
        }
        this.requests.delete(message.requestId)
        pending.resolve(message)
        return
      }
      case 'output': {
        const job = this.jobs.get(message.jobId)
        if (!job) return
        const chunks: ProcessOutputChunk[] = []
        for (const [stream, text] of message.chunks) {
          if (!isOutputStream(stream)) {
            job.fail(
              new NativeProcessBrokerError(
                'protocolViolation',
                `Process job ${message.jobId} emitted unknown stream ${stream}.`
              )
            )
            return
          }
          chunks.push({ stream, text })
        }
        job.deliverOutput(message.sequence, chunks, message.truncated, message.totalBytes)
        return
      }
      case 'timedOut':
        this.jobs.get(message.jobId)?.markTimedOut()
        return
      case 'exited': {
        const job = this.jobs.get(message.jobId)
        if (!job) return
        this.jobs.delete(message.jobId)
        job.markExited({
          exitCode: message.exitCode,
          timedOut: message.timedOut,
          cancelled: message.cancelled,
          spilled: message.spilled,
          totalBytes: message.totalBytes,
          ...(message.error === null ? {} : { error: message.error })
        })
        return
      }
      case 'error': {
        const error = new NativeProcessBrokerError(message.code, message.message)
        if (message.requestId) {
          const pending = this.requests.get(message.requestId)
          if (pending) {
            this.requests.delete(message.requestId)
            pending.reject(error)
            return
          }
        }
        if (message.jobId) {
          const job = this.jobs.get(message.jobId)
          this.jobs.delete(message.jobId)
          job?.fail(error)
          return
        }
        this.failBroker(error)
      }
    }
  }

  private failBroker(error: unknown): void {
    const failure = toError(error)
    this.ready?.reject(failure)
    for (const pending of this.requests.values()) pending.reject(failure)
    this.requests.clear()
    for (const job of this.jobs.values()) job.fail(failure)
    this.jobs.clear()
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      const termination = forceTerminateChildProcess(child)
      if (!termination.delivered && !termination.alreadyExited) {
        console.error(
          '[yachiyo][process-host] failed to terminate broken broker',
          termination.error
        )
      }
    }
  }
}

export function resolveProcessHostBinary(): string {
  const binaryName = process.platform === 'win32' ? 'process-host.exe' : 'process-host'
  const binary = resolveBundledExecutable({
    name: binaryName,
    startDir: import.meta.dirname,
    additionalCandidates: [
      resolve(process.cwd(), 'native/process-host/target/release', binaryName),
      resolve(process.cwd(), 'native/process-host/target/debug', binaryName)
    ]
  })
  if (!binary) {
    throw new NativeProcessBrokerError(
      'binaryUnavailable',
      'process-host binary is unavailable. Run pnpm run process-host:build.'
    )
  }
  return binary
}
