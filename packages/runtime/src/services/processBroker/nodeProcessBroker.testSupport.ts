import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import { forceTerminateChildProcess } from '../../app/domain/processes/processTree.ts'
import { resolveHostShellRuntime } from '../../runtime/shell/shellRuntime.ts'
import type {
  ProcessBroker,
  ProcessJob,
  ProcessJobOutcome,
  ProcessJobResult,
  ProcessOutputBatch,
  ProcessOutputChunk,
  StartProcessJobInput
} from './processBroker.ts'

class NodeTestProcessJob implements ProcessJob {
  readonly id: string
  readonly pid: number
  readonly logPath: string
  private readonly child: ChildProcess
  private readonly listeners = new Set<(batch: ProcessOutputBatch) => void>()
  private readonly terminal = Promise.withResolvers<ProcessJobResult>()
  private readonly outcome = Promise.withResolvers<ProcessJobOutcome>()
  private outcomeSettled = false
  private terminalSettled = false
  private sequence = 0
  private totalBytes = 0
  private totalChars = 0
  private timedOut = false
  private cancelled = false
  private retainLog: boolean
  private readonly spillThresholdChars: number
  private readonly logStream: WriteStream
  private timeout: ReturnType<typeof setTimeout> | undefined

  constructor(input: StartProcessJobInput, child: ChildProcess) {
    if (child.pid === undefined) throw new Error(`Test process job ${input.id} has no pid.`)
    this.id = input.id
    this.pid = child.pid
    this.logPath = input.logPath
    this.child = child
    this.retainLog = input.retainLog
    this.spillThresholdChars = input.spillThresholdChars
    this.logStream = createWriteStream(input.logPath, { encoding: 'utf8', flags: 'w' })

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => this.deliver('stdout', text))
    child.stderr?.on('data', (text: string) => this.deliver('stderr', text))
    child.once('error', (error) => this.finish(1, error.message))
    child.once('close', (code) => this.finish(code ?? (this.timedOut ? 124 : 1)))

    if (input.timeoutSeconds !== undefined) {
      this.timeout = setTimeout(() => {
        this.timedOut = true
        if (!this.outcomeSettled) {
          this.outcomeSettled = true
          this.outcome.resolve({ kind: 'timed-out' })
        }
        if (input.keepRunningOnTimeout) {
          this.retainLog = true
        } else {
          forceTerminateChildProcess(child)
        }
      }, input.timeoutSeconds * 1000)
    }
  }

  onOutput(listener: (batch: ProcessOutputBatch) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  waitForOutcome(): Promise<ProcessJobOutcome> {
    return this.outcome.promise
  }

  wait(): Promise<ProcessJobResult> {
    return this.terminal.promise
  }

  cancel(): void {
    if (this.terminalSettled) return
    this.cancelled = forceTerminateChildProcess(this.child).delivered
  }

  private deliver(stream: ProcessOutputChunk['stream'], text: string): void {
    this.logStream.write(text)
    this.totalBytes += Buffer.byteLength(text)
    this.totalChars += text.length
    const batch: ProcessOutputBatch = {
      sequence: this.sequence++,
      chunks: [{ stream, text }],
      truncated: false,
      totalBytes: this.totalBytes
    }
    for (const listener of this.listeners) listener(batch)
  }

  private finish(exitCode: number, error?: string): void {
    if (this.terminalSettled) return
    this.terminalSettled = true
    clearTimeout(this.timeout)
    this.logStream.end(() => {
      void this.finalizeLog(exitCode, error)
    })
  }

  private async finalizeLog(exitCode: number, error?: string): Promise<void> {
    try {
      const spilled = this.retainLog || this.totalChars >= this.spillThresholdChars
      if (!spilled) await rm(this.logPath, { force: true })
      const result: ProcessJobResult = {
        exitCode,
        timedOut: this.timedOut,
        cancelled: this.cancelled,
        spilled,
        totalBytes: this.totalBytes,
        ...(error ? { error } : {})
      }
      this.terminal.resolve(result)
      if (!this.outcomeSettled) {
        this.outcomeSettled = true
        this.outcome.resolve({ kind: 'exited', result })
      }
      this.listeners.clear()
    } catch (finalizeError) {
      this.terminal.reject(finalizeError)
      if (!this.outcomeSettled) this.outcome.reject(finalizeError)
    }
  }
}

export class NodeProcessBrokerTestAdapter implements ProcessBroker {
  private readonly jobs = new Set<ProcessJob>()
  private readonly shellRuntime = resolveHostShellRuntime({
    env: process.env,
    readLoginShellEnvironment: () => process.env
  })

  start(): Promise<void> {
    return Promise.resolve()
  }

  async startJob(input: StartProcessJobInput): Promise<ProcessJob> {
    await mkdir(dirname(input.logPath), { recursive: true })
    const command = this.shellRuntime.command(input.command, { cwd: input.cwd })
    const child = spawn(command.executable, command.args, {
      ...command.options,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const job = new NodeTestProcessJob(input, child)
    this.jobs.add(job)
    void job.wait().then(
      () => this.jobs.delete(job),
      () => this.jobs.delete(job)
    )
    return job
  }

  async close(): Promise<void> {
    for (const job of this.jobs) job.cancel()
    await Promise.allSettled([...this.jobs].map((job) => job.wait()))
    this.jobs.clear()
  }
}
