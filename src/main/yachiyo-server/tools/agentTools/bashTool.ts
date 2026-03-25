import { tool, type Tool } from 'ai'

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { BashToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

import {
  bashToolInputSchema,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  MAX_BASH_DETAILS_OUTPUT_CHARS,
  MAX_BASH_MODEL_OUTPUT_CHARS,
  type AgentToolContext,
  type BashRunner,
  type BashToolInput,
  type BashToolOutput,
  takeTail,
  textContent,
  toToolModelOutput,
  truncateForDetails
} from './shared.ts'

export function createTool(context: AgentToolContext): Tool<BashToolInput, BashToolOutput> {
  return tool({
    description: `Run a shell command with cwd set to ${context.workspacePath}. Use timeout in seconds.`,
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
}): { content: { type: 'text'; text: string }[]; truncated: boolean } {
  const baseText = summarizeCombinedBashOutput(input.combinedOutput)

  if (baseText.length > 0) {
    const tail = takeTail(baseText, MAX_BASH_MODEL_OUTPUT_CHARS)
    const note =
      tail.truncated && input.outputFilePath
        ? `\n\n[truncated output: full log saved to ${input.outputFilePath}]`
        : ''

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

export function isBlockedBashCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (!/(^|[;&|])\s*(sudo\s+)?(\/bin\/)?rm\b/.test(normalized)) {
    return false
  }

  return /(^|[;&|])\s*(sudo\s+)?(\/bin\/)?rm\b(?:\s+-[-\w]+|\s+--)*\s+(?:\/(?:\s|$)|\/[*](?:\s|$)|\/(?:System|Library|Applications|usr|bin|sbin|etc|var|opt)(?:\/|\s|$))/.test(
    normalized
  )
}

const defaultBashRunner: BashRunner = async ({
  abortSignal,
  command,
  cwd,
  onStderr,
  onStdout,
  timeoutSeconds
}) => {
  const child = spawn('/bin/zsh', ['-lc', command], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let terminatedByAbort = false
  const shouldBufferStdout = onStdout === undefined
  const shouldBufferStderr = onStderr === undefined

  const forceKillChild = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    try {
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

  child.stdout?.on('data', (chunk: string) => {
    if (shouldBufferStdout) {
      stdout += chunk
    }
    onStdout?.(chunk)
  })

  child.stderr?.on('data', (chunk: string) => {
    if (shouldBufferStderr) {
      stderr += chunk
    }
    onStderr?.(chunk)
  })

  const timeoutHandle = setTimeout(() => {
    timedOut = true
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
    })

    return {
      exitCode: timedOut && exitCode === 0 ? 124 : exitCode,
      stderr,
      stdout,
      ...(timedOut ? { timedOut: true } : {})
    }
  } finally {
    clearTimeout(timeoutHandle)
    abortSignal?.removeEventListener('abort', onAbort)
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

  if (isBlockedBashCommand(command)) {
    queue.push(
      createBashResult({
        command,
        combinedOutput: '',
        cwd: context.workspacePath,
        stdout: '',
        stderr: '',
        blocked: true,
        error: 'Blocked an obviously catastrophic destructive command.'
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
  let outputFilePath: string | undefined
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

  void (async () => {
    try {
      await mkdir(join(context.workspacePath, '.yachiyo', 'tool-output'), { recursive: true })

      const runner = options.runCommand ?? defaultBashRunner
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
        }
      })

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
          ...(outputFilePath ? { outputFilePath } : {}),
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
          ...(outputFilePath ? { outputFilePath } : {}),
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
