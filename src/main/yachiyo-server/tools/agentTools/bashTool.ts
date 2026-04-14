import { tool, type Tool } from 'ai'

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { BashToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

import { validateBashCommand } from './bashSecurity.ts'
import {
  bashToolInputSchema,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  MAX_BASH_DETAILS_OUTPUT_CHARS,
  MAX_BASH_MODEL_OUTPUT_CHARS,
  type AgentToolContext,
  type BashRunner,
  type BashToolInput,
  type BashToolOutput,
  type ToolContentBlock,
  takeTail,
  textContent,
  toToolModelOutput,
  truncateForDetails
} from './shared.ts'

export function createTool(context: AgentToolContext): Tool<BashToolInput, BashToolOutput> {
  return tool({
    description:
      `Run a shell command with cwd set to ${context.workspacePath}. Use timeout in seconds.\n` +
      'Do NOT use bash for searching code or finding files — use the `grep` tool (content search) or `glob` tool (file discovery) instead. They are faster, produce structured output, and respect workspace boundaries.',
    inputSchema: bashToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) =>
      streamBashTool(input, context, {
        abortSignal: options.abortSignal,
        toolCallId: options.toolCallId
      })
  })
}

function appendTail(value: string, chunk: string, maxChars: number): string {
  return takeTail(`${value}${chunk}`, maxChars).text
}

async function closeWriteStream(stream?: WriteStream): Promise<void> {
  if (!stream) {
    return
  }

  stream.end()
  await once(stream, 'close')
}

function summarizeCombinedBashOutput(value: string): string {
  return value
}

function toAbortError(reason: unknown, fallbackMessage: string): Error {
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : fallbackMessage
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function buildBashContent(input: {
  combinedOutput: string
  error?: string
  exitCode?: number
  outputFilePath?: string
  preliminary?: boolean
}): { content: ToolContentBlock[]; truncated: boolean } {
  const baseText = summarizeCombinedBashOutput(input.combinedOutput)

  if (baseText.length > 0) {
    const tail = takeTail(baseText, MAX_BASH_MODEL_OUTPUT_CHARS)

    if (input.outputFilePath && !input.preliminary) {
      return {
        content: textContent(
          `Output too large to inline. Full output saved to ${input.outputFilePath}.\nUse the read tool to read it.`
        ),
        truncated: true
      }
    }

    const note = ''

    return {
      content: textContent(`${tail.text}${note}`),
      truncated: tail.truncated
    }
  }

  if (input.preliminary) {
    return {
      content: [],
      truncated: false
    }
  }

  if (input.error) {
    return {
      content: textContent(input.error),
      truncated: false
    }
  }

  return {
    content: textContent(`Command exited ${input.exitCode ?? 0} with no output.`),
    truncated: false
  }
}

function createBashResult(input: {
  command: string
  cwd: string
  combinedOutput?: string
  stdout: string
  stderr: string
  exitCode?: number
  blocked?: boolean
  timedOut?: boolean
  error?: string
  outputFilePath?: string
  preliminary?: boolean
}): BashToolOutput {
  const combinedOutput = input.combinedOutput ?? `${input.stdout}${input.stderr}`
  const stdoutTail = truncateForDetails(input.stdout)
  const stderrTail = truncateForDetails(input.stderr)
  const content = buildBashContent({
    combinedOutput,
    error: input.error,
    exitCode: input.exitCode,
    outputFilePath: input.outputFilePath,
    preliminary: input.preliminary
  })
  const truncated =
    content.truncated ||
    stdoutTail.truncated ||
    stderrTail.truncated ||
    Boolean(input.outputFilePath)

  const details: BashToolCallDetails = {
    command: input.command,
    cwd: input.cwd,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    stdout: stdoutTail.text,
    stderr: stderrTail.text,
    ...(truncated ? { truncated: true } : {}),
    ...(input.timedOut ? { timedOut: true } : {}),
    ...(input.blocked ? { blocked: true } : {}),
    ...(input.outputFilePath ? { outputFilePath: input.outputFilePath } : {})
  }

  return {
    content: content.content,
    details,
    ...(input.error ? { error: input.error } : {}),
    metadata: {
      cwd: input.cwd,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(truncated ? { truncated: true } : {}),
      ...(input.blocked ? { blocked: true } : {}),
      ...(input.timedOut ? { timedOut: true } : {}),
      ...(input.outputFilePath ? { outputFilePath: input.outputFilePath } : {})
    }
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    reject: (error: unknown) => void
    resolve: (value: IteratorResult<T>) => void
  }> = []
  private closed = false
  private error: unknown

  push(value: T): void {
    if (this.closed || this.error !== undefined) {
      return
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ done: false, value })
      return
    }

    this.values.push(value)
  }

  close(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.resolve({ done: true, value: undefined })
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.error !== undefined) {
      return
    }

    this.error = error
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.reject(error)
    }
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T
        continue
      }

      if (this.error !== undefined) {
        throw this.error
      }

      if (this.closed) {
        return
      }

      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.waiters.push({ reject, resolve })
      })

      if (next.done) {
        return
      }

      yield next.value
    }
  }
}

// Re-export for backward compatibility
export { isBlockedBashCommand, isSelfLaunchCommand } from './bashSecurity.ts'

const defaultBashRunner: BashRunner = async ({
  abortSignal,
  command,
  cwd,
  onStderr,
  onStdout,
  onTimeoutLift,
  timeoutSeconds
}) => {
  const child = spawn('/bin/zsh', ['-lc', command], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let lifted = false
  let terminatedByAbort = false
  const shouldBufferStdout = onStdout === undefined
  const shouldBufferStderr = onStderr === undefined

  const forceKillChild = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    try {
      if (child.pid != null) {
        try {
          process.kill(-child.pid, 'SIGKILL')
          return
        } catch {
          // Fall through to killing only the shell if the process group no longer exists.
        }
      }
      child.kill('SIGKILL')
    } catch {
      // ESRCH if the kernel already reaped the child.
    }
  }

  const onAbort = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }

    terminatedByAbort = true
    forceKillChild()
  }

  if (abortSignal?.aborted) {
    onAbort()
  } else {
    abortSignal?.addEventListener('abort', onAbort, { once: true })
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')

  const onStdoutData = (chunk: string): void => {
    if (shouldBufferStdout) {
      stdout += chunk
    }
    onStdout?.(chunk)
  }
  const onStderrData = (chunk: string): void => {
    if (shouldBufferStderr) {
      stderr += chunk
    }
    onStderr?.(chunk)
  }
  child.stdout?.on('data', onStdoutData)
  child.stderr?.on('data', onStderrData)

  let resolveLifted: (() => void) | undefined
  const liftedPromise = new Promise<void>((res) => {
    resolveLifted = res
  })

  const timeoutHandle = setTimeout(() => {
    timedOut = true
    if (onTimeoutLift) {
      void onTimeoutLift(child).then(
        (adopted) => {
          if (adopted) {
            lifted = true
            // Detach our listeners so the new owner has a clean handoff.
            child.stdout?.off('data', onStdoutData)
            child.stderr?.off('data', onStderrData)
            if (abortSignal) {
              abortSignal.removeEventListener('abort', onAbort)
            }
            resolveLifted?.()
          } else {
            forceKillChild()
          }
        },
        () => {
          forceKillChild()
        }
      )
      return
    }
    forceKillChild()
  }, timeoutSeconds * 1000)

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        if (terminatedByAbort) {
          reject(toAbortError(abortSignal?.reason, 'Tool execution aborted.'))
          return
        }

        resolve(typeof code === 'number' ? code : timedOut ? 124 : 1)
      })
      void liftedPromise.then(() => {
        // The child is still running; resolve immediately so the runner returns.
        resolve(0)
      })
    })

    if (lifted) {
      return {
        exitCode: 0,
        stderr,
        stdout,
        lifted: true
      }
    }

    return {
      exitCode: timedOut && exitCode === 0 ? 124 : exitCode,
      stderr,
      stdout,
      ...(timedOut ? { timedOut: true } : {})
    }
  } finally {
    clearTimeout(timeoutHandle)
    if (!lifted) {
      abortSignal?.removeEventListener('abort', onAbort)
    }
  }
}

export async function* streamBashTool(
  input: BashToolInput,
  context: AgentToolContext,
  options: { abortSignal?: AbortSignal; runCommand?: BashRunner; toolCallId?: string } = {}
): AsyncIterable<BashToolOutput> {
  const queue = new AsyncQueue<BashToolOutput>()
  const command = input.command.trim()
  const timeoutSeconds = input.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS

  const securityCheck = validateBashCommand(command)

  // Background mode: spawn the detached process first, then return the handle
  if (input.background && !securityCheck.blocked) {
    const taskId = options.toolCallId ?? randomUUID()
    const logPath = join(context.workspacePath, '.yachiyo', 'tool-output', `${taskId}.log`)

    try {
      await context.onBackgroundBashStarted?.({
        taskId,
        command,
        cwd: context.workspacePath,
        logPath,
        toolCallId: options.toolCallId
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Background task failed to start.'
      yield createBashResult({
        command,
        combinedOutput: '',
        cwd: context.workspacePath,
        stdout: '',
        stderr: '',
        error: message
      })
      return
    }

    const handle = { taskId, logPath }
    yield {
      content: [{ type: 'text', text: JSON.stringify(handle) }],
      details: {
        command,
        cwd: context.workspacePath,
        stdout: '',
        stderr: '',
        background: true,
        taskId,
        logPath
      },
      metadata: { cwd: context.workspacePath }
    }
    return
  }

  if (securityCheck.blocked) {
    queue.push(
      createBashResult({
        command,
        combinedOutput: '',
        cwd: context.workspacePath,
        stdout: '',
        stderr: '',
        blocked: true,
        error: securityCheck.message
      })
    )
    queue.close()
    yield* queue.iterate()
    return
  }

  let stdout = ''
  let stderr = ''
  let combinedOutput = ''
  let sawStreamChunks = false
  // Pre-allocate background-task identity. The lift log path doubles as the
  // foreground spill path so a command that overflows MAX_BASH_MODEL_OUTPUT_CHARS
  // before timing out doesn't lose its early bytes when adopted.
  const liftTaskId = options.toolCallId ?? randomUUID()
  const liftLogPath = join(context.workspacePath, '.yachiyo', 'tool-output', `${liftTaskId}.log`)
  let outputFilePath: string | undefined = liftLogPath
  let preSpillOutput = ''
  let spillStarted = false
  let spillStream: WriteStream | undefined

  const ensureSpillStream = (): WriteStream => {
    if (!outputFilePath) {
      outputFilePath = join(
        context.workspacePath,
        '.yachiyo',
        'tool-output',
        `${options.toolCallId ?? randomUUID()}.log`
      )
    }

    if (!spillStream) {
      spillStream = createWriteStream(outputFilePath, {
        encoding: 'utf8',
        flags: 'w'
      })
    }

    return spillStream
  }

  const pushPreliminary = (): void => {
    queue.push(
      createBashResult({
        command,
        combinedOutput,
        cwd: context.workspacePath,
        stdout,
        stderr,
        preliminary: true
      })
    )
  }

  const appendChunk = (
    streamName: 'stdout' | 'stderr',
    chunk: string,
    emitUpdate: boolean
  ): void => {
    sawStreamChunks = true

    if (!spillStarted) {
      preSpillOutput += chunk
    }

    if (streamName === 'stdout') {
      stdout = appendTail(stdout, chunk, MAX_BASH_DETAILS_OUTPUT_CHARS)
    } else {
      stderr = appendTail(stderr, chunk, MAX_BASH_DETAILS_OUTPUT_CHARS)
    }

    combinedOutput = appendTail(combinedOutput, chunk, MAX_BASH_MODEL_OUTPUT_CHARS)

    if (spillStarted) {
      ensureSpillStream().write(chunk)
    } else if (preSpillOutput.length >= MAX_BASH_MODEL_OUTPUT_CHARS) {
      spillStarted = true
      ensureSpillStream().write(preSpillOutput)
      preSpillOutput = ''
    }

    if (emitUpdate) {
      pushPreliminary()
    }
  }

  let liftedHandle: { taskId: string; logPath: string } | undefined

  void (async () => {
    try {
      await mkdir(join(context.workspacePath, '.yachiyo', 'tool-output'), { recursive: true })

      // Layer 2: Pre-backup files that bash might modify
      if (context.snapshotTracker) {
        try {
          const { extractBashTargetFiles } =
            await import('../../services/fileSnapshot/bashTargetExtractor.ts')
          const targets = extractBashTargetFiles(command, context.workspacePath)
          for (const target of targets) {
            await context.snapshotTracker.trackBeforeWrite(target)
          }
        } catch {
          // Don't block bash execution for snapshot errors
        }
      }

      const runner = options.runCommand ?? defaultBashRunner
      const adoptHook = context.onBackgroundBashAdopted
      const result = await runner({
        abortSignal: options.abortSignal,
        command,
        cwd: context.workspacePath,
        timeoutSeconds,
        onStdout: (chunk) => {
          appendChunk('stdout', chunk, true)
        },
        onStderr: (chunk) => {
          appendChunk('stderr', chunk, true)
        },
        ...(adoptHook
          ? {
              onTimeoutLift: async (child) => {
                try {
                  // Flush and close the spill stream first so the file on disk
                  // contains the full pre-timeout history before adoption opens it.
                  if (spillStream) {
                    await closeWriteStream(spillStream)
                    spillStream = undefined
                  }

                  let initialOutput: string
                  if (spillStarted) {
                    try {
                      initialOutput = await readFile(liftLogPath, 'utf8')
                    } catch {
                      // Fall back to the truncated tail if we somehow can't read
                      // back the spill file — better than losing everything.
                      initialOutput = combinedOutput
                    }
                  } else {
                    initialOutput = combinedOutput
                  }

                  await adoptHook({
                    taskId: liftTaskId,
                    command,
                    cwd: context.workspacePath,
                    logPath: liftLogPath,
                    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
                    child,
                    initialOutput,
                    initialOutputAlreadyOnDisk: spillStarted
                  })
                  liftedHandle = { taskId: liftTaskId, logPath: liftLogPath }
                  return true
                } catch (error) {
                  console.warn('[yachiyo][bash] failed to adopt timed-out child', {
                    taskId: liftTaskId,
                    error: error instanceof Error ? error.message : String(error)
                  })
                  return false
                }
              }
            }
          : {})
      })

      if (liftedHandle) {
        await closeWriteStream(spillStream)
        queue.push({
          content: [{ type: 'text', text: JSON.stringify(liftedHandle) }],
          details: {
            command,
            cwd: context.workspacePath,
            stdout: truncateForDetails(stdout).text,
            stderr: truncateForDetails(stderr).text,
            background: true,
            taskId: liftedHandle.taskId,
            logPath: liftedHandle.logPath,
            liftedAfterTimeout: true
          },
          metadata: { cwd: context.workspacePath }
        })
        queue.close()
        return
      }

      if (!sawStreamChunks) {
        if (result.stdout) {
          appendChunk('stdout', result.stdout, false)
        }
        if (result.stderr) {
          appendChunk('stderr', result.stderr, false)
        }
      }

      await closeWriteStream(spillStream)
      const error = result.timedOut
        ? `Command timed out after ${timeoutSeconds} second${timeoutSeconds === 1 ? '' : 's'}.`
        : result.exitCode === 0
          ? undefined
          : `Command exited with code ${result.exitCode}.`

      queue.push(
        createBashResult({
          command,
          combinedOutput,
          cwd: context.workspacePath,
          exitCode: result.exitCode,
          stdout,
          stderr,
          ...(result.timedOut ? { timedOut: true } : {}),
          ...(spillStarted && outputFilePath ? { outputFilePath } : {}),
          ...(error ? { error } : {})
        })
      )
      queue.close()
    } catch (error) {
      await closeWriteStream(spillStream)

      if (error instanceof Error && error.name === 'AbortError') {
        queue.fail(error)
        return
      }

      const message = error instanceof Error ? error.message : 'Command failed.'
      queue.push(
        createBashResult({
          command,
          combinedOutput,
          cwd: context.workspacePath,
          stdout,
          stderr,
          ...(spillStarted && outputFilePath ? { outputFilePath } : {}),
          error: message
        })
      )
      queue.close()
    }
  })()

  yield* queue.iterate()
}

export async function runBashTool(
  input: BashToolInput,
  context: AgentToolContext,
  options: { abortSignal?: AbortSignal; runCommand?: BashRunner; toolCallId?: string } = {}
): Promise<BashToolOutput> {
  let finalResult: BashToolOutput | undefined

  for await (const result of streamBashTool(input, context, options)) {
    finalResult = result
  }

  if (!finalResult) {
    throw new Error('Bash tool did not produce a final result.')
  }

  return finalResult
}
