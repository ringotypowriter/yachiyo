import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface BackgroundBashTaskInput {
  taskId: string
  command: string
  cwd: string
  logPath: string
  toolCallId?: string
  threadId: string
}

export interface BackgroundBashAdoptInput extends BackgroundBashTaskInput {
  /** Already-running child process to adopt instead of spawning a new one. */
  child: ChildProcess
  /** Output already collected before adoption; written to the log first. */
  initialOutput: string
  /**
   * When true, `initialOutput` is already persisted at `logPath`. The manager
   * opens the log in append mode and skips re-writing those bytes, but still
   * replays them as live log-append events for the renderer's session view.
   */
  initialOutputAlreadyOnDisk?: boolean
}

export interface BackgroundBashTaskResult {
  taskId: string
  command: string
  logPath: string
  exitCode: number
  threadId: string
  toolCallId?: string
}

export interface BackgroundBashLogAppend {
  taskId: string
  threadId: string
  lines: string[]
}

export type BackgroundTaskSnapshotStatus = 'running' | 'completed' | 'failed'

export interface BackgroundBashSnapshot {
  taskId: string
  threadId: string
  command: string
  logPath: string
  startedAt: string
  status: BackgroundTaskSnapshotStatus
  exitCode?: number
  finishedAt?: string
}

interface ActiveBackgroundTask {
  taskId: string
  command: string
  cwd: string
  logPath: string
  toolCallId?: string
  threadId: string
  startedAt: string
  process: ChildProcess
  logStream: WriteStream
  abortController: AbortController
  promise: Promise<BackgroundBashTaskResult>
  /** Buffer holding partial trailing data not yet terminated by a newline. */
  pendingLineBuffer: string
  /** Pending complete lines waiting to be flushed in the next throttle window. */
  pendingFlushLines: string[]
  flushTimer: NodeJS.Timeout | null
}

interface RecentlyCompletedTask {
  snapshot: BackgroundBashSnapshot
  evictTimer: NodeJS.Timeout
}

export type BackgroundBashCompletionHandler = (result: BackgroundBashTaskResult) => void
export type BackgroundBashLogAppendHandler = (append: BackgroundBashLogAppend) => void

const FLUSH_INTERVAL_MS = 100
const MAX_LINES_PER_BATCH = 50
const RECENTLY_COMPLETED_TTL_MS = 10_000

export class BackgroundBashManager {
  private readonly tasks = new Map<string, ActiveBackgroundTask>()
  private readonly recentlyCompleted = new Map<string, RecentlyCompletedTask>()
  private onCompleted?: BackgroundBashCompletionHandler
  private onLogAppend?: BackgroundBashLogAppendHandler

  setCompletionHandler(handler: BackgroundBashCompletionHandler): void {
    this.onCompleted = handler
  }

  setLogAppendHandler(handler: BackgroundBashLogAppendHandler): void {
    this.onLogAppend = handler
  }

  async startTask(input: BackgroundBashTaskInput): Promise<void> {
    const child = spawn('/bin/zsh', ['-lc', input.command], {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    await this.registerChild(input, child, '', false)
  }

  async adoptTask(input: BackgroundBashAdoptInput): Promise<void> {
    await this.registerChild(
      input,
      input.child,
      input.initialOutput,
      input.initialOutputAlreadyOnDisk === true
    )
  }

  private async registerChild(
    input: BackgroundBashTaskInput,
    child: ChildProcess,
    initialOutput: string,
    initialOutputAlreadyOnDisk: boolean
  ): Promise<void> {
    await mkdir(dirname(input.logPath), { recursive: true })

    // When the bytes are already on disk we append; otherwise truncate-and-write.
    const logStream = createWriteStream(input.logPath, {
      encoding: 'utf8',
      flags: initialOutputAlreadyOnDisk ? 'a' : 'w'
    })
    if (!initialOutputAlreadyOnDisk && initialOutput.length > 0) {
      logStream.write(initialOutput)
    }
    const abortController = new AbortController()
    const startedAt = new Date().toISOString()

    const task: ActiveBackgroundTask = {
      taskId: input.taskId,
      command: input.command,
      cwd: input.cwd,
      logPath: input.logPath,
      toolCallId: input.toolCallId,
      threadId: input.threadId,
      startedAt,
      process: child,
      logStream,
      abortController,
      // Filled in below.
      promise: undefined as unknown as Promise<BackgroundBashTaskResult>,
      pendingLineBuffer: '',
      pendingFlushLines: [],
      flushTimer: null
    }

    const onChunk = (chunk: string): void => {
      logStream.write(chunk)
      this.bufferLogChunk(task, chunk)
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    const onAbort = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill('SIGKILL')
      } catch {
        // ESRCH if already reaped
      }
    }
    abortController.signal.addEventListener('abort', onAbort, { once: true })

    const waitForLogFlush = (): Promise<void> =>
      new Promise<void>((resolve) => logStream.end(resolve))

    const finalize = async (exitCode: number): Promise<BackgroundBashTaskResult> => {
      // Flush any trailing partial line as a final line so the UI sees it.
      if (task.pendingLineBuffer.length > 0) {
        task.pendingFlushLines.push(task.pendingLineBuffer)
        task.pendingLineBuffer = ''
      }
      this.flushPendingLines(task)
      if (task.flushTimer) {
        clearTimeout(task.flushTimer)
        task.flushTimer = null
      }

      await waitForLogFlush()

      const result: BackgroundBashTaskResult = {
        taskId: input.taskId,
        command: input.command,
        logPath: input.logPath,
        exitCode,
        threadId: input.threadId,
        toolCallId: input.toolCallId
      }
      this.tasks.delete(input.taskId)
      abortController.signal.removeEventListener('abort', onAbort)
      this.rememberCompletion(task, exitCode)
      this.onCompleted?.(result)
      return result
    }

    task.promise = new Promise<number>((resolve) => {
      child.once('close', (code) => resolve(typeof code === 'number' ? code : 1))
      child.once('error', () => resolve(1))
    }).then((exitCode) => finalize(exitCode))

    this.tasks.set(input.taskId, task)

    // Replay pre-adoption output as live log-append events so the renderer's
    // session view shows the bytes that arrived before the task became visible.
    // No-op for fresh startTask calls (initialOutput is empty there).
    if (initialOutput.length > 0) {
      this.bufferLogChunk(task, initialOutput)
    }
  }

  private bufferLogChunk(task: ActiveBackgroundTask, chunk: string): void {
    if (!chunk) return
    const combined = task.pendingLineBuffer + chunk
    const parts = combined.split('\n')
    task.pendingLineBuffer = parts.pop() ?? ''
    for (const line of parts) {
      task.pendingFlushLines.push(line)
    }
    this.scheduleFlush(task)
  }

  private scheduleFlush(task: ActiveBackgroundTask): void {
    if (task.pendingFlushLines.length === 0) return
    if (task.flushTimer) return
    task.flushTimer = setTimeout(() => {
      task.flushTimer = null
      this.flushPendingLines(task)
    }, FLUSH_INTERVAL_MS)
  }

  private flushPendingLines(task: ActiveBackgroundTask): void {
    while (task.pendingFlushLines.length > 0) {
      const batch = task.pendingFlushLines.splice(0, MAX_LINES_PER_BATCH)
      try {
        this.onLogAppend?.({
          taskId: task.taskId,
          threadId: task.threadId,
          lines: batch
        })
      } catch (error) {
        console.warn('[yachiyo][background-bash] log-append handler failed', {
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  private rememberCompletion(task: ActiveBackgroundTask, exitCode: number): void {
    const snapshot: BackgroundBashSnapshot = {
      taskId: task.taskId,
      threadId: task.threadId,
      command: task.command,
      logPath: task.logPath,
      startedAt: task.startedAt,
      status: exitCode === 0 ? 'completed' : 'failed',
      exitCode,
      finishedAt: new Date().toISOString()
    }
    const existing = this.recentlyCompleted.get(task.taskId)
    if (existing) {
      clearTimeout(existing.evictTimer)
    }
    const evictTimer = setTimeout(() => {
      this.recentlyCompleted.delete(task.taskId)
    }, RECENTLY_COMPLETED_TTL_MS)
    // Don't keep the event loop alive just to evict a snapshot.
    if (typeof evictTimer.unref === 'function') {
      evictTimer.unref()
    }
    this.recentlyCompleted.set(task.taskId, { snapshot, evictTimer })
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    task.abortController.abort()
    return true
  }

  getTask(taskId: string): { taskId: string; threadId: string; command: string } | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    return { taskId: task.taskId, threadId: task.threadId, command: task.command }
  }

  get activeCount(): number {
    return this.tasks.size
  }

  /**
   * Snapshot of all known tasks (running + recently-completed) for a thread.
   * Used to hydrate the renderer when a thread is opened.
   */
  listSnapshots(threadId: string): BackgroundBashSnapshot[] {
    const out: BackgroundBashSnapshot[] = []
    for (const task of this.tasks.values()) {
      if (task.threadId !== threadId) continue
      out.push({
        taskId: task.taskId,
        threadId: task.threadId,
        command: task.command,
        logPath: task.logPath,
        startedAt: task.startedAt,
        status: 'running'
      })
    }
    for (const entry of this.recentlyCompleted.values()) {
      if (entry.snapshot.threadId !== threadId) continue
      out.push(entry.snapshot)
    }
    return out
  }

  async close(): Promise<void> {
    for (const task of this.tasks.values()) {
      task.abortController.abort()
    }
    if (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks.values()].map((t) => t.promise))
    }
    for (const entry of this.recentlyCompleted.values()) {
      clearTimeout(entry.evictTimer)
    }
    this.recentlyCompleted.clear()
  }
}
