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

export interface BackgroundBashTaskResult {
  taskId: string
  command: string
  logPath: string
  exitCode: number
  threadId: string
  toolCallId?: string
}

interface ActiveBackgroundTask {
  taskId: string
  command: string
  cwd: string
  logPath: string
  toolCallId?: string
  threadId: string
  process: ChildProcess
  logStream: WriteStream
  abortController: AbortController
  promise: Promise<BackgroundBashTaskResult>
}

export type BackgroundBashCompletionHandler = (result: BackgroundBashTaskResult) => void

export class BackgroundBashManager {
  private readonly tasks = new Map<string, ActiveBackgroundTask>()
  private onCompleted?: BackgroundBashCompletionHandler

  setCompletionHandler(handler: BackgroundBashCompletionHandler): void {
    this.onCompleted = handler
  }

  async startTask(input: BackgroundBashTaskInput): Promise<void> {
    await mkdir(dirname(input.logPath), { recursive: true })

    const logStream = createWriteStream(input.logPath, { encoding: 'utf8', flags: 'w' })
    const abortController = new AbortController()

    const child = spawn('/bin/zsh', ['-lc', input.command], {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => logStream.write(chunk))
    child.stderr?.on('data', (chunk: string) => logStream.write(chunk))

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
      this.onCompleted?.(result)
      return result
    }

    const promise = new Promise<number>((resolve) => {
      child.once('close', (code) => resolve(typeof code === 'number' ? code : 1))
      child.once('error', () => resolve(1))
    }).then((exitCode) => finalize(exitCode))

    const task: ActiveBackgroundTask = {
      taskId: input.taskId,
      command: input.command,
      cwd: input.cwd,
      logPath: input.logPath,
      toolCallId: input.toolCallId,
      threadId: input.threadId,
      process: child,
      logStream,
      abortController,
      promise
    }

    this.tasks.set(input.taskId, task)
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

  async close(): Promise<void> {
    for (const task of this.tasks.values()) {
      task.abortController.abort()
    }
    if (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks.values()].map((t) => t.promise))
    }
  }
}
