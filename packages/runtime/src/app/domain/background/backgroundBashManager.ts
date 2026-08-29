import type {
  ProcessBroker,
  ProcessJob,
  ProcessJobResult
} from '../../../services/processBroker/processBroker.ts'

export interface BackgroundBashTaskInput {
  taskId: string
  command: string
  description?: string
  cwd: string
  env?: NodeJS.ProcessEnv
  logPath: string
  threadId: string
  toolCallId?: string
}

export interface BackgroundBashAdoptInput extends BackgroundBashTaskInput {
  job: ProcessJob
  /** Bounded foreground tail replayed once so the background log view starts with context. */
  initialOutput: string
}

export interface BackgroundBashTaskResult {
  taskId: string
  command: string
  description?: string
  logPath: string
  exitCode?: number
  threadId: string
  toolCallId?: string
  pid?: number
  cancelledByUser?: boolean
  error?: string
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
  description?: string
  logPath: string
  startedAt: string
  status: BackgroundTaskSnapshotStatus
  exitCode?: number
  finishedAt?: string
  cancelledByUser?: boolean
  error?: string
}

export interface BackgroundBashLogTarget {
  taskId: string
  threadId: string
  command: string
  description?: string
  logPath: string
}

interface ActiveBackgroundTask {
  taskId: string
  command: string
  description?: string
  cwd: string
  logPath: string
  toolCallId?: string
  threadId: string
  startedAt: string
  job: ProcessJob
  unsubscribeOutput?: () => void
  promise?: Promise<BackgroundBashTaskResult>
  pendingLineBuffer: string
  pendingFlushLines: string[]
  flushTimer: ReturnType<typeof setTimeout> | null
  cancelRequestedByUser: boolean
}

interface RecentlyCompletedTask {
  snapshot: BackgroundBashSnapshot
  result: BackgroundBashTaskResult
  evictTimer: ReturnType<typeof setTimeout>
}

export type BackgroundBashCompletionHandler = (result: BackgroundBashTaskResult) => void
export type BackgroundBashLogAppendHandler = (append: BackgroundBashLogAppend) => void

const FLUSH_INTERVAL_MS = 100
const MAX_LINES_PER_BATCH = 50
const RECENTLY_COMPLETED_TTL_MS = 10_000
const TRUNCATED_OUTPUT_NOTICE =
  '[Output skipped in live view; full output remains in the task log.]'
const BACKGROUND_SPILL_THRESHOLD_CHARS = 20_000

export class BackgroundBashManager {
  private readonly tasks = new Map<string, ActiveBackgroundTask>()
  private readonly recentlyCompleted = new Map<string, RecentlyCompletedTask>()
  private onCompleted?: BackgroundBashCompletionHandler
  private onLogAppend?: BackgroundBashLogAppendHandler
  private readonly processBroker: ProcessBroker

  constructor(processBroker: ProcessBroker) {
    this.processBroker = processBroker
  }

  setCompletionHandler(handler: BackgroundBashCompletionHandler): void {
    this.onCompleted = handler
  }

  setLogAppendHandler(handler: BackgroundBashLogAppendHandler): void {
    this.onLogAppend = handler
  }

  async startTask(input: BackgroundBashTaskInput): Promise<void> {
    const job = await this.processBroker.startJob({
      id: input.taskId,
      command: input.command,
      cwd: input.cwd,
      env: input.env ?? process.env,
      logPath: input.logPath,
      keepRunningOnTimeout: false,
      retainLog: true,
      spillThresholdChars: BACKGROUND_SPILL_THRESHOLD_CHARS
    })
    this.registerJob(input, job, '')
  }

  async adoptTask(input: BackgroundBashAdoptInput): Promise<void> {
    if (input.job.id !== input.taskId) {
      throw new Error(
        `Cannot adopt process job ${input.job.id} as background task ${input.taskId}.`
      )
    }
    if (input.job.logPath !== input.logPath) {
      throw new Error(`Process job ${input.job.id} log path does not match its background task.`)
    }
    this.registerJob(input, input.job, input.initialOutput)
  }

  private registerJob(
    input: BackgroundBashTaskInput,
    job: ProcessJob,
    initialOutput: string
  ): void {
    if (this.tasks.has(input.taskId)) {
      throw new Error(`Background task already exists: ${input.taskId}`)
    }

    const task: ActiveBackgroundTask = {
      taskId: input.taskId,
      command: input.command,
      description: input.description,
      cwd: input.cwd,
      logPath: input.logPath,
      toolCallId: input.toolCallId,
      threadId: input.threadId,
      startedAt: new Date().toISOString(),
      job,
      pendingLineBuffer: '',
      pendingFlushLines: [],
      flushTimer: null,
      cancelRequestedByUser: false
    }

    task.unsubscribeOutput = job.onOutput((batch) => {
      if (batch.truncated) this.bufferLogChunk(task, `${TRUNCATED_OUTPUT_NOTICE}\n`)
      for (const chunk of batch.chunks) this.bufferLogChunk(task, chunk.text)
    })
    if (initialOutput.length > 0) this.bufferLogChunk(task, initialOutput)
    task.promise = job.wait().then(
      (result) => this.finalize(task, result),
      (error: unknown) => this.finalizeRejected(task, error)
    )
    this.tasks.set(input.taskId, task)
  }

  private finalize(
    task: ActiveBackgroundTask,
    processResult: ProcessJobResult
  ): BackgroundBashTaskResult {
    const cancelledByUser = task.cancelRequestedByUser && processResult.cancelled
    return this.settleTask(task, {
      exitCode: processResult.exitCode,
      ...(cancelledByUser ? { cancelledByUser: true } : {}),
      ...(processResult.error ? { error: processResult.error } : {})
    })
  }

  private finalizeRejected(task: ActiveBackgroundTask, error: unknown): BackgroundBashTaskResult {
    return this.settleTask(task, {
      error: error instanceof Error ? error.message : String(error)
    })
  }

  private settleTask(
    task: ActiveBackgroundTask,
    terminal: Pick<BackgroundBashTaskResult, 'exitCode' | 'cancelledByUser' | 'error'>
  ): BackgroundBashTaskResult {
    if (task.pendingLineBuffer.length > 0) {
      task.pendingFlushLines.push(task.pendingLineBuffer)
      task.pendingLineBuffer = ''
    }
    this.flushPendingLines(task)
    if (task.flushTimer) {
      clearTimeout(task.flushTimer)
      task.flushTimer = null
    }
    if (!task.unsubscribeOutput) {
      throw new Error(`Background task ${task.taskId} has no native output subscription.`)
    }
    task.unsubscribeOutput()

    const result: BackgroundBashTaskResult = {
      taskId: task.taskId,
      command: task.command,
      ...(task.description ? { description: task.description } : {}),
      logPath: task.logPath,
      threadId: task.threadId,
      ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
      pid: task.job.pid,
      ...terminal
    }
    this.tasks.delete(task.taskId)
    this.rememberCompletion(task, result)
    this.onCompleted?.(result)
    return result
  }

  private bufferLogChunk(task: ActiveBackgroundTask, chunk: string): void {
    if (!chunk) return
    const combined = task.pendingLineBuffer + chunk
    const parts = combined.split('\n')
    task.pendingLineBuffer = parts.pop() ?? ''
    for (const line of parts) task.pendingFlushLines.push(line)
    this.scheduleFlush(task)
  }

  private scheduleFlush(task: ActiveBackgroundTask): void {
    if (task.pendingFlushLines.length === 0 || task.flushTimer) return
    task.flushTimer = setTimeout(() => {
      task.flushTimer = null
      this.flushPendingLines(task)
    }, FLUSH_INTERVAL_MS)
  }

  private flushPendingLines(task: ActiveBackgroundTask): void {
    for (let offset = 0; offset < task.pendingFlushLines.length; offset += MAX_LINES_PER_BATCH) {
      const lines = task.pendingFlushLines.slice(offset, offset + MAX_LINES_PER_BATCH)
      try {
        this.onLogAppend?.({ taskId: task.taskId, threadId: task.threadId, lines })
      } catch (error) {
        console.warn('[yachiyo][background-bash] log-append handler failed', {
          taskId: task.taskId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    task.pendingFlushLines = []
  }

  private rememberCompletion(task: ActiveBackgroundTask, result: BackgroundBashTaskResult): void {
    const cancelledByUser = result.cancelledByUser === true
    const snapshot: BackgroundBashSnapshot = {
      taskId: task.taskId,
      threadId: task.threadId,
      command: task.command,
      ...(task.description ? { description: task.description } : {}),
      logPath: task.logPath,
      startedAt: task.startedAt,
      status:
        cancelledByUser || result.error !== undefined || result.exitCode !== 0
          ? 'failed'
          : 'completed',
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      finishedAt: new Date().toISOString(),
      ...(cancelledByUser ? { cancelledByUser: true } : {}),
      ...(result.error !== undefined ? { error: result.error } : {})
    }
    const existing = this.recentlyCompleted.get(task.taskId)
    if (existing) clearTimeout(existing.evictTimer)
    const evictTimer = setTimeout(
      () => this.recentlyCompleted.delete(task.taskId),
      RECENTLY_COMPLETED_TTL_MS
    )
    evictTimer.unref?.()
    this.recentlyCompleted.set(task.taskId, { snapshot, result, evictTimer })
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false
    task.cancelRequestedByUser = true
    task.job.cancel()
    return true
  }

  getTask(taskId: string): { taskId: string; threadId: string; command: string } | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    return { taskId: task.taskId, threadId: task.threadId, command: task.command }
  }

  getLogTarget(threadId: string, taskId: string): BackgroundBashLogTarget | undefined {
    const task = this.tasks.get(taskId)
    if (task) {
      if (task.threadId !== threadId) return undefined
      return {
        taskId: task.taskId,
        threadId: task.threadId,
        command: task.command,
        ...(task.description ? { description: task.description } : {}),
        logPath: task.logPath
      }
    }

    const completed = this.recentlyCompleted.get(taskId)?.snapshot
    if (!completed || completed.threadId !== threadId) return undefined
    return {
      taskId: completed.taskId,
      threadId: completed.threadId,
      command: completed.command,
      ...(completed.description ? { description: completed.description } : {}),
      logPath: completed.logPath
    }
  }

  getCompletedTask(taskId: string): BackgroundBashTaskResult | undefined {
    const completed = this.recentlyCompleted.get(taskId)?.result
    return completed ? { ...completed } : undefined
  }

  get activeCount(): number {
    return this.tasks.size
  }

  listSnapshots(threadId?: string): BackgroundBashSnapshot[] {
    const output: BackgroundBashSnapshot[] = []
    for (const task of this.tasks.values()) {
      if (threadId !== undefined && task.threadId !== threadId) continue
      output.push({
        taskId: task.taskId,
        threadId: task.threadId,
        command: task.command,
        ...(task.description ? { description: task.description } : {}),
        logPath: task.logPath,
        startedAt: task.startedAt,
        status: 'running'
      })
    }
    for (const entry of this.recentlyCompleted.values()) {
      if (threadId !== undefined && entry.snapshot.threadId !== threadId) continue
      output.push(entry.snapshot)
    }
    return output
  }
  async close(): Promise<void> {
    const pending: Promise<BackgroundBashTaskResult>[] = []
    for (const task of this.tasks.values()) {
      task.job.cancel()
      if (!task.promise) {
        throw new Error(`Background task ${task.taskId} has no completion promise.`)
      }
      pending.push(task.promise)
    }
    await Promise.allSettled(pending)
    for (const entry of this.recentlyCompleted.values()) clearTimeout(entry.evictTimer)
    this.recentlyCompleted.clear()
  }
}
