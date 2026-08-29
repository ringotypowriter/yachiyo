import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import type {
  ProcessJob,
  ProcessJobOutcome,
  ProcessJobResult,
  ProcessOutputBatch
} from '../../../services/processBroker/processBroker.ts'
import { NodeProcessBrokerTestAdapter } from '../../../services/processBroker/nodeProcessBroker.testSupport.ts'
import {
  BackgroundBashManager,
  type BackgroundBashLogAppend,
  type BackgroundBashTaskResult
} from './backgroundBashManager.ts'
import { buildBashCommand } from '../../../runtime/shell/shellRuntime.ts'

class ControllableProcessJob implements ProcessJob {
  readonly id: string
  readonly pid = 4242
  readonly logPath: string
  private readonly listeners = new Set<(batch: ProcessOutputBatch) => void>()
  private readonly terminal = Promise.withResolvers<ProcessJobResult>()
  private readonly outcome = Promise.withResolvers<ProcessJobOutcome>()
  private sequence = 0
  private settled = false
  onCancel: () => void

  constructor(id: string, logPath: string) {
    this.id = id
    this.logPath = logPath
    this.onCancel = () =>
      this.complete({
        exitCode: 130,
        timedOut: false,
        cancelled: true,
        spilled: true,
        totalBytes: 0
      })
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
    this.onCancel()
  }

  emit(text: string, truncated = false): void {
    const batch: ProcessOutputBatch = {
      sequence: this.sequence++,
      chunks: [{ stream: 'stdout', text }],
      truncated,
      totalBytes: Buffer.byteLength(text)
    }
    for (const listener of this.listeners) listener(batch)
  }

  complete(result: ProcessJobResult): void {
    if (this.settled) return
    this.settled = true
    this.terminal.resolve(result)
    this.outcome.resolve({ kind: 'exited', result })
  }

  fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.terminal.reject(error)
    this.outcome.reject(error)
  }
}

function completionOf(manager: BackgroundBashManager): Promise<BackgroundBashTaskResult> {
  const completed = Promise.withResolvers<BackgroundBashTaskResult>()
  manager.setCompletionHandler(completed.resolve)
  return completed.promise
}

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bg-bash-test-'))
}

async function readLogUntil(logPath: string, pattern: RegExp): Promise<RegExpMatchArray> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      const log = await readFile(logPath, 'utf8')
      const match = log.match(pattern)
      if (match) return match
    } catch {
      // The log file is created asynchronously after the child starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${pattern} in ${logPath}`)
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('BackgroundBashManager', () => {
  it('runs a command and calls completion handler with exit code', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const completed = completionOf(manager)

      const logPath = join(tempDir, 'tool-output', 'test-task.log')
      await manager.startTask({
        taskId: 'test-task',
        command: 'echo hello && echo world',
        cwd: tempDir,
        logPath,
        threadId: 'thread-1',
        toolCallId: 'tc-1'
      })

      const result = await completed
      assert.equal(result.taskId, 'test-task')
      assert.equal(result.exitCode, 0)
      assert.equal(result.threadId, 'thread-1')
      assert.equal(result.toolCallId, 'tc-1')
      assert.equal(result.command, 'echo hello && echo world')
      assert.equal(result.logPath, logPath)

      const log = await readFile(logPath, 'utf8')
      assert.ok(log.includes('hello'))
      assert.ok(log.includes('world'))
      assert.equal(manager.activeCount, 0)
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('uses the scoped environment supplied by the launching run', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const completed = completionOf(manager)
      const logPath = join(tempDir, 'tool-output', 'run-env.log')

      await manager.startTask({
        taskId: 'run-env-task',
        command: 'printf %s "$YACHIYO_RUN_ID"',
        cwd: tempDir,
        env: { ...process.env, YACHIYO_RUN_ID: 'run-self' },
        logPath,
        threadId: 'thread-run-env'
      })

      await completed
      assert.equal(await readFile(logPath, 'utf8'), 'run-self')
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('reports non-zero exit code for failing commands', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const completed = completionOf(manager)

      await manager.startTask({
        taskId: 'fail-task',
        command: 'exit 42',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'fail.log'),
        threadId: 'thread-2'
      })

      const result = await completed
      assert.equal(result.exitCode, 42)
      assert.equal(result.taskId, 'fail-task')
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('captures stderr in the log file', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const completed = completionOf(manager)

      const logPath = join(tempDir, 'tool-output', 'stderr.log')
      await manager.startTask({
        taskId: 'stderr-task',
        command: 'echo err-output >&2',
        cwd: tempDir,
        logPath,
        threadId: 'thread-3'
      })

      await completed
      const log = await readFile(logPath, 'utf8')
      assert.ok(log.includes('err-output'))
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('cancelTask kills the process', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const completed = completionOf(manager)

      await manager.startTask({
        taskId: 'cancel-task',
        command: 'sleep 60',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'cancel.log'),
        threadId: 'thread-4'
      })

      assert.equal(manager.activeCount, 1)
      const cancelled = manager.cancelTask('cancel-task')
      assert.ok(cancelled)

      const result = await completed
      assert.notEqual(result.exitCode, 0)
      assert.equal(manager.activeCount, 0)
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('cancelTask kills a child left alive by a shell-backgrounded command', async () => {
    const tempDir = await createTempDir()
    const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
    let childPid: number | undefined
    try {
      const completed = completionOf(manager)
      const logPath = join(tempDir, 'tool-output', 'shell-backgrounded.log')
      const childPidPath = join(tempDir, 'child.pid')
      const windowsChildCommand = buildBashCommand(process.execPath.replaceAll('\\', '/'), [
        '-e',
        `require('fs').writeFileSync('child.pid', String(process.pid)); setTimeout(() => {}, 30_000)`
      ])
      const command =
        process.platform === 'win32' ? `${windowsChildCommand} & wait` : 'sleep 30 & echo child:$!'

      await manager.startTask({
        taskId: 'shell-backgrounded-task',
        command,
        cwd: tempDir,
        logPath,
        threadId: 'thread-shell-backgrounded'
      })

      const match =
        process.platform === 'win32'
          ? await readLogUntil(childPidPath, /(\d+)/)
          : await readLogUntil(logPath, /child:(\d+)/)
      childPid = Number(match[1])
      assert.equal(isProcessAlive(childPid), true)
      assert.equal(manager.activeCount, 1)

      assert.equal(manager.cancelTask('shell-backgrounded-task'), true)

      const result = await withTimeout(completed, 2000)
      assert.equal(result.cancelledByUser, true)
      assert.equal(manager.activeCount, 0)
      assert.equal(isProcessAlive(childPid), false)

      const [snapshot] = manager.listSnapshots('thread-shell-backgrounded')
      assert.equal(snapshot?.status, 'failed')
      assert.equal(snapshot?.cancelledByUser, true)
    } finally {
      manager.cancelTask('shell-backgrounded-task')
      if (childPid != null && isProcessAlive(childPid)) {
        process.kill(childPid, 'SIGKILL')
      }
      await rm(tempDir, { recursive: true })
    }
  })

  it('cancelTask returns false for unknown taskId', () => {
    const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
    assert.equal(manager.cancelTask('nonexistent'), false)
  })

  it('does not mark a naturally completed task as cancelled when cancel races with exit', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const completed = Promise.withResolvers<BackgroundBashTaskResult>()
      manager.setCompletionHandler(completed.resolve)
      const logPath = join(tempDir, 'tool-output', 'race.log')
      const job = new ControllableProcessJob('race-task', logPath)
      job.onCancel = () =>
        job.complete({
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          spilled: true,
          totalBytes: 0
        })

      await manager.adoptTask({
        taskId: 'race-task',
        command: 'echo done',
        cwd: tempDir,
        logPath,
        threadId: 'thread-race',
        job,
        initialOutput: ''
      })

      assert.equal(manager.cancelTask('race-task'), true)
      const result = await completed.promise
      assert.equal(result.exitCode, 0)
      assert.equal(result.cancelledByUser, undefined)

      const [snapshot] = manager.listSnapshots('thread-race')
      assert.equal(snapshot?.status, 'completed')
      assert.equal(snapshot?.cancelledByUser, undefined)
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('finalizes rejected native jobs as failed background completions', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const completionHandler = mock.fn<(result: BackgroundBashTaskResult) => void>()
      manager.setCompletionHandler(completionHandler)
      const logPath = join(tempDir, 'tool-output', 'rejected.log')
      const job = new ControllableProcessJob('rejected-task', logPath)
      void job.waitForOutcome().catch(() => {})

      await manager.adoptTask({
        taskId: 'rejected-task',
        command: 'native-command',
        cwd: tempDir,
        logPath,
        threadId: 'thread-rejected',
        job,
        initialOutput: 'partial'
      })
      job.fail(new Error('process host crashed'))
      await Promise.resolve()
      await Promise.resolve()

      assert.equal(completionHandler.mock.callCount(), 1)
      const result = completionHandler.mock.calls[0]?.arguments[0]
      assert.equal(result?.exitCode, undefined)
      assert.equal(result?.error, 'process host crashed')
      assert.equal(manager.activeCount, 0)
      const [snapshot] = manager.listSnapshots('thread-rejected')
      assert.equal(snapshot?.status, 'failed')
      assert.equal(snapshot?.error, 'process host crashed')
      await manager.close()
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('treats resolved native I/O errors as background failures', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const completed = completionOf(manager)
      const logPath = join(tempDir, 'tool-output', 'io-error.log')
      const job = new ControllableProcessJob('io-error-task', logPath)

      await manager.adoptTask({
        taskId: 'io-error-task',
        command: 'native-command',
        cwd: tempDir,
        logPath,
        threadId: 'thread-io-error',
        job,
        initialOutput: ''
      })
      job.complete({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        spilled: true,
        totalBytes: 7,
        error: 'Flush process log: disk full'
      })

      const result = await completed
      assert.equal(result.exitCode, 0)
      assert.equal(result.error, 'Flush process log: disk full')
      const [snapshot] = manager.listSnapshots('thread-io-error')
      assert.equal(snapshot?.status, 'failed')
      assert.equal(snapshot?.error, 'Flush process log: disk full')
      await manager.close()
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('getTask returns task info for active task', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const completed = completionOf(manager)

      await manager.startTask({
        taskId: 'info-task',
        command: 'sleep 60',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'info.log'),
        threadId: 'thread-5'
      })

      const info = manager.getTask('info-task')
      assert.ok(info)
      assert.equal(info.taskId, 'info-task')
      assert.equal(info.threadId, 'thread-5')
      assert.equal(info.command, 'sleep 60')

      const logTarget = manager.getLogTarget('thread-5', 'info-task')
      assert.deepEqual(logTarget, {
        taskId: 'info-task',
        threadId: 'thread-5',
        command: 'sleep 60',
        logPath: join(tempDir, 'tool-output', 'info.log')
      })
      assert.equal(manager.getLogTarget('other-thread', 'info-task'), undefined)
      assert.equal(manager.getTask('nonexistent'), undefined)

      manager.cancelTask('info-task')
      await completed
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('close kills all active tasks', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const handler = mock.fn<(result: BackgroundBashTaskResult) => void>()
      manager.setCompletionHandler(handler)

      await manager.startTask({
        taskId: 'close-1',
        command: 'sleep 60',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'close1.log'),
        threadId: 'thread-6'
      })
      await manager.startTask({
        taskId: 'close-2',
        command: 'sleep 60',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'close2.log'),
        threadId: 'thread-6'
      })

      assert.equal(manager.activeCount, 2)
      await manager.close()
      assert.equal(manager.activeCount, 0)
      assert.equal(handler.mock.callCount(), 2)
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('streams log lines through the log-append handler', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const collected: string[] = []
      manager.setLogAppendHandler((event: BackgroundBashLogAppend) => {
        for (const line of event.lines) collected.push(line)
      })
      const completed = completionOf(manager)

      await manager.startTask({
        taskId: 'log-task',
        command: 'printf "alpha\\nbeta\\ngamma\\n"',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'log.log'),
        threadId: 'thread-log'
      })

      await completed
      // Allow any throttled flush to land.
      await new Promise((r) => setTimeout(r, 150))

      assert.deepEqual(
        collected.filter((l) => l.length > 0),
        ['alpha', 'beta', 'gamma']
      )
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('listSnapshots returns running tasks and recently-completed entries', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const completed = completionOf(manager)

      await manager.startTask({
        taskId: 'snap-running',
        command: 'sleep 30',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'snap-running.log'),
        threadId: 'snap-thread'
      })

      await manager.startTask({
        taskId: 'snap-done',
        command: 'true',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'snap-done.log'),
        threadId: 'snap-thread'
      })

      await completed

      const snaps = manager.listSnapshots('snap-thread')
      const byId = new Map(snaps.map((s) => [s.taskId, s]))
      assert.equal(byId.get('snap-running')?.status, 'running')
      assert.equal(byId.get('snap-done')?.status, 'completed')
      assert.equal(byId.get('snap-done')?.exitCode, 0)
      assert.deepEqual(
        manager
          .listSnapshots()
          .map((s) => s.taskId)
          .sort(),
        ['snap-done', 'snap-running']
      )

      // Tasks for other threads must not leak.
      assert.equal(manager.listSnapshots('other-thread').length, 0)

      manager.cancelTask('snap-running')
      await manager.close()
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('adopts an existing native job and replays the bounded foreground tail', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager(new NodeProcessBrokerTestAdapter())
      const collected: string[] = []
      manager.setLogAppendHandler((event: BackgroundBashLogAppend) => {
        collected.push(...event.lines)
      })
      const completed = Promise.withResolvers<BackgroundBashTaskResult>()
      manager.setCompletionHandler(completed.resolve)
      const logPath = join(tempDir, 'tool-output', 'adopt.log')
      const job = new ControllableProcessJob('adopt-task', logPath)

      await manager.adoptTask({
        taskId: 'adopt-task',
        command: 'long-running-command',
        cwd: tempDir,
        logPath,
        threadId: 'thread-adopt',
        job,
        initialOutput: 'before-1\nbefore-2\n'
      })
      job.emit('after-1\nafter-2\n', true)
      job.complete({
        exitCode: 0,
        timedOut: true,
        cancelled: false,
        spilled: true,
        totalBytes: 16
      })

      const result = await completed.promise
      assert.equal(result.exitCode, 0)
      assert.equal(result.pid, 4242)
      const visibleLines = collected.filter((line) => line.length > 0)
      assert.deepEqual(visibleLines.slice(0, 2), ['before-1', 'before-2'])
      assert.match(visibleLines[2] ?? '', /Output skipped/u)
      assert.deepEqual(visibleLines.slice(3), ['after-1', 'after-2'])
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })
})
