import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import type {
  BashToolCallDetails,
  EditToolCallDetails,
  ReadToolCallDetails,
  ToolCallDetailsSnapshot,
  ToolCallName,
  ToolCallStatus,
  WriteToolCallDetails
} from '../../shared/yachiyo/protocol'

const DEFAULT_READ_LIMIT = 200
const MAX_READ_LIMIT = 500
const DEFAULT_READ_MAX_BYTES = 16_000

const DEFAULT_BASH_TIMEOUT_SECONDS = 30
const MAX_BASH_TIMEOUT_SECONDS = 120
const MAX_BASH_MODEL_OUTPUT_CHARS = 20_000
const MAX_BASH_DETAILS_OUTPUT_CHARS = 8_000

const readToolInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional()
})

const writeToolInputSchema = z.object({
  path: z.string().min(1),
  content: z.string()
})

const editToolInputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string()
})

const bashToolInputSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().min(1).max(MAX_BASH_TIMEOUT_SECONDS).optional()
})

type ReadToolInput = z.infer<typeof readToolInputSchema>
type WriteToolInput = z.infer<typeof writeToolInputSchema>
type EditToolInput = z.infer<typeof editToolInputSchema>
type BashToolInput = z.infer<typeof bashToolInputSchema>

interface AgentToolContext {
  workspacePath: string
}

export interface ToolContentBlock {
  type: 'text'
  text: string
}

export interface AgentToolMetadata {
  cwd?: string
  exitCode?: number
  blocked?: boolean
  timedOut?: boolean
  truncated?: boolean
  outputFilePath?: string
}

export interface AgentToolResult<TDetails extends ToolCallDetailsSnapshot> {
  content: ToolContentBlock[]
  details: TDetails
  metadata: AgentToolMetadata
  error?: string
}

export type ReadToolOutput = AgentToolResult<ReadToolCallDetails>
export type WriteToolOutput = AgentToolResult<WriteToolCallDetails>
export type EditToolOutput = AgentToolResult<EditToolCallDetails>
export type BashToolOutput = AgentToolResult<BashToolCallDetails>

export type AgentToolOutput = ReadToolOutput | WriteToolOutput | EditToolOutput | BashToolOutput

interface BashRunnerInput {
  command: string
  cwd: string
  timeoutSeconds: number
  abortSignal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

interface BashRunnerResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
}

type BashRunner = (input: BashRunnerInput) => Promise<BashRunnerResult>

function resolveToolPath(workspacePath: string, targetPath: string): string {
  return isAbsolute(targetPath) ? resolve(targetPath) : resolve(workspacePath, targetPath)
}

function hasAccess(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = 0

  while (true) {
    const nextIndex = haystack.indexOf(needle, index)
    if (nextIndex === -1) {
      return count
    }

    count += 1
    index = nextIndex + needle.length
  }
}

function countNewlines(value: string): number {
  return value.length === 0 ? 0 : (value.match(/\n/g) ?? []).length
}

function textContent(text: string): ToolContentBlock[] {
  return text.length === 0 ? [] : [{ type: 'text', text }]
}

function flattenToolContent(content: ToolContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function truncateUtf8ByBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')

  if (bytes.length <= maxBytes) {
    return value
  }

  return Buffer.from(bytes.subarray(0, maxBytes)).toString('utf8')
}

function takeTail(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return {
      text: value,
      truncated: false
    }
  }

  return {
    text: value.slice(-maxChars),
    truncated: true
  }
}

function truncateForDetails(value: string): { text: string; truncated: boolean } {
  return takeTail(value, MAX_BASH_DETAILS_OUTPUT_CHARS)
}

function summarizeCombinedBashOutput(value: string): string {
  return value
}

function buildReadExcerpt(
  lines: string[],
  input: ReadToolInput
): {
  excerpt: string
  endLine: number
  nextOffset?: number
  remainingLines?: number
  truncated: boolean
} {
  const offset = input.offset ?? 0
  const limit = input.limit ?? DEFAULT_READ_LIMIT

  if (offset >= lines.length) {
    return {
      excerpt: '',
      endLine: offset,
      truncated: false
    }
  }

  const selectedLines: string[] = []
  let bytes = 0
  let consumedLines = 0
  let truncatedByBytes = false
  let returnedPartialFirstLine = false

  for (const line of lines.slice(offset, offset + limit)) {
    const addition = selectedLines.length === 0 ? line : `\n${line}`
    const additionBytes = Buffer.byteLength(addition, 'utf8')

    if (bytes + additionBytes > DEFAULT_READ_MAX_BYTES) {
      if (selectedLines.length === 0) {
        selectedLines.push(truncateUtf8ByBytes(line, DEFAULT_READ_MAX_BYTES))
        returnedPartialFirstLine = true
      }

      truncatedByBytes = true
      break
    }

    selectedLines.push(line)
    bytes += additionBytes
    consumedLines += 1
  }

  const nextOffset = offset + consumedLines
  const remainingLines = Math.max(lines.length - nextOffset, 0)
  const truncated = truncatedByBytes || remainingLines > 0

  return {
    excerpt: selectedLines.join('\n'),
    endLine:
      consumedLines === 0
        ? returnedPartialFirstLine
          ? offset + 1
          : offset
        : offset + consumedLines,
    ...(truncated ? { nextOffset } : {}),
    ...(truncated ? { remainingLines } : {}),
    truncated
  }
}

function buildEditDiff(
  path: string,
  original: string,
  nextContent: string,
  matchStart: number,
  oldText: string,
  newText: string
): { diff: string; firstChangedLine: number } {
  const contextLineCount = 2
  const firstChangedLine = countNewlines(original.slice(0, matchStart)) + 1
  const lastOldChangedLine = countNewlines(original.slice(0, matchStart + oldText.length)) + 1
  const lastNewChangedLine =
    newText.length === 0
      ? firstChangedLine
      : countNewlines(nextContent.slice(0, matchStart + newText.length)) + 1

  const originalLines = original.length === 0 ? [] : original.split(/\r?\n/)
  const nextLines = nextContent.length === 0 ? [] : nextContent.split(/\r?\n/)

  const oldStartLine = Math.max(1, firstChangedLine - contextLineCount)
  const newStartLine = Math.max(1, firstChangedLine - contextLineCount)

  const beforeLines = originalLines.slice(oldStartLine - 1, firstChangedLine - 1)
  const oldChangedLines = originalLines.slice(firstChangedLine - 1, lastOldChangedLine)
  const newChangedLines = nextLines.slice(firstChangedLine - 1, lastNewChangedLine)
  const afterLines = nextLines.slice(
    lastNewChangedLine,
    Math.min(nextLines.length, lastNewChangedLine + contextLineCount)
  )

  const oldBlockCount = beforeLines.length + oldChangedLines.length + afterLines.length
  const newBlockCount = beforeLines.length + newChangedLines.length + afterLines.length

  const diff = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${oldStartLine},${oldBlockCount} +${newStartLine},${newBlockCount} @@`,
    ...beforeLines.map((line) => ` ${line}`),
    ...oldChangedLines.map((line) => `-${line}`),
    ...newChangedLines.map((line) => `+${line}`),
    ...afterLines.map((line) => ` ${line}`)
  ].join('\n')

  return {
    diff,
    firstChangedLine
  }
}

function createReadErrorResult(path: string, error: string): ReadToolOutput {
  return {
    content: textContent(error),
    details: {
      path,
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      totalBytes: 0,
      truncated: false
    },
    error,
    metadata: {}
  }
}

function createWriteResult(
  path: string,
  details: WriteToolCallDetails,
  error?: string
): WriteToolOutput {
  const action = details.overwritten ? 'Overwrote' : 'Wrote'
  const message = error ?? `${action} ${details.bytesWritten} bytes to ${path}.`

  return {
    content: textContent(message),
    details,
    ...(error ? { error } : {}),
    metadata: {}
  }
}

function createEditResult(
  path: string,
  details: EditToolCallDetails,
  error?: string
): EditToolOutput {
  const message =
    error ??
    `Updated ${path} at line ${details.firstChangedLine ?? 1}.\n\n${details.diff ?? ''}`.trim()

  return {
    content: textContent(message),
    details,
    ...(error ? { error } : {}),
    metadata: {}
  }
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

  return {
    content: content.content,
    details: {
      command: input.command,
      cwd: input.cwd,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      stdout: stdoutTail.text,
      stderr: stderrTail.text,
      ...(truncated ? { truncated: true } : {}),
      ...(input.timedOut ? { timedOut: true } : {}),
      ...(input.blocked ? { blocked: true } : {}),
      ...(input.outputFilePath ? { outputFilePath: input.outputFilePath } : {})
    },
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
  const shouldBufferStdout = onStdout === undefined
  const shouldBufferStderr = onStderr === undefined

  const onAbort = (): void => {
    const error =
      abortSignal?.reason instanceof Error
        ? abortSignal.reason
        : new Error('Tool execution aborted.')
    error.name = 'AbortError'
    child.kill('SIGTERM')
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
    child.kill('SIGTERM')
  }, timeoutSeconds * 1000)

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        if (abortSignal?.aborted) {
          const error =
            abortSignal.reason instanceof Error
              ? abortSignal.reason
              : new Error('Tool execution aborted.')
          error.name = 'AbortError'
          reject(error)
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

export async function runReadTool(
  input: ReadToolInput,
  context: AgentToolContext
): Promise<ReadToolOutput> {
  const resolvedPath = resolveToolPath(context.workspacePath, input.path)

  try {
    const rawContent = await readFile(resolvedPath, 'utf8')
    const lines = rawContent.length === 0 ? [] : rawContent.split(/\r?\n/)
    const excerpt = buildReadExcerpt(lines, input)
    const details: ReadToolCallDetails = {
      path: resolvedPath,
      startLine: (input.offset ?? 0) + 1,
      endLine: excerpt.endLine,
      totalLines: lines.length,
      totalBytes: Buffer.byteLength(rawContent, 'utf8'),
      truncated: excerpt.truncated,
      ...(excerpt.nextOffset === undefined ? {} : { nextOffset: excerpt.nextOffset }),
      ...(excerpt.remainingLines === undefined ? {} : { remainingLines: excerpt.remainingLines })
    }
    const continuationHint =
      excerpt.truncated && excerpt.nextOffset !== undefined
        ? `\n\n[truncated: continue with offset ${excerpt.nextOffset}]`
        : ''

    return {
      content: textContent(`${excerpt.excerpt}${continuationHint}`),
      details,
      metadata: {}
    }
  } catch (error) {
    return createReadErrorResult(
      resolvedPath,
      error instanceof Error ? error.message : 'Unable to read file.'
    )
  }
}

export async function runWriteTool(
  input: WriteToolInput,
  context: AgentToolContext
): Promise<WriteToolOutput> {
  const resolvedPath = resolveToolPath(context.workspacePath, input.path)

  try {
    const exists = await hasAccess(resolvedPath)
    await mkdir(dirname(resolvedPath), { recursive: true })
    await writeFile(resolvedPath, input.content, 'utf8')

    return createWriteResult(resolvedPath, {
      path: resolvedPath,
      bytesWritten: Buffer.byteLength(input.content, 'utf8'),
      created: !exists,
      overwritten: exists
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to write file.'
    return createWriteResult(
      resolvedPath,
      {
        path: resolvedPath,
        bytesWritten: 0,
        created: false,
        overwritten: false
      },
      message
    )
  }
}

export async function runEditTool(
  input: EditToolInput,
  context: AgentToolContext
): Promise<EditToolOutput> {
  const resolvedPath = resolveToolPath(context.workspacePath, input.path)

  try {
    const original = await readFile(resolvedPath, 'utf8')
    const occurrences = countOccurrences(original, input.oldText)

    if (occurrences === 0) {
      return createEditResult(
        resolvedPath,
        {
          path: resolvedPath,
          replacements: 0
        },
        'Search text was not found in the target file.'
      )
    }

    if (occurrences > 1) {
      return createEditResult(
        resolvedPath,
        {
          path: resolvedPath,
          replacements: 0
        },
        'Search text matched multiple locations. Make oldText more specific before retrying.'
      )
    }

    const matchStart = original.indexOf(input.oldText)
    const nextContent = original.replace(input.oldText, input.newText)
    await writeFile(resolvedPath, nextContent, 'utf8')

    const diff = buildEditDiff(
      resolvedPath,
      original,
      nextContent,
      matchStart,
      input.oldText,
      input.newText
    )

    return createEditResult(resolvedPath, {
      path: resolvedPath,
      replacements: 1,
      diff: diff.diff,
      firstChangedLine: diff.firstChangedLine
    })
  } catch (error) {
    return createEditResult(
      resolvedPath,
      {
        path: resolvedPath,
        replacements: 0
      },
      error instanceof Error ? error.message : 'Unable to edit file.'
    )
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

  const appendChunk = (streamName: 'stdout' | 'stderr', chunk: string, emitUpdate: boolean): void => {
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

function isToolFailure(output: unknown): output is AgentToolOutput {
  return typeof output === 'object' && output !== null && 'error' in output
}

function getOutputError(output: unknown): string | undefined {
  return isToolFailure(output) && typeof output.error === 'string' ? output.error : undefined
}

export function summarizeToolInput(toolName: ToolCallName, input: unknown): string {
  if (toolName === 'bash') {
    const command =
      typeof input === 'object' && input !== null && 'command' in input ? input.command : ''
    return typeof command === 'string' ? takeTail(command, 160).text : toolName
  }

  const path = typeof input === 'object' && input !== null && 'path' in input ? input.path : ''
  return typeof path === 'string' && path.trim().length > 0 ? path : toolName
}

export function summarizeToolOutput(
  toolName: ToolCallName,
  output: unknown,
  options: { phase?: 'update' | 'end' } = {}
): string {
  const phase = options.phase ?? 'end'
  const error = getOutputError(output)

  if (error) {
    return error
  }

  if (toolName === 'read') {
    const details = (output as ReadToolOutput).details
    const summary = `lines ${details.startLine}-${details.endLine}`
    return details.truncated ? `${summary} (truncated)` : summary
  }

  if (toolName === 'write') {
    const details = (output as WriteToolOutput).details
    return details.overwritten
      ? `overwrote ${details.bytesWritten} bytes`
      : `wrote ${details.bytesWritten} bytes`
  }

  if (toolName === 'edit') {
    const details = (output as EditToolOutput).details
    return details.firstChangedLine === undefined
      ? `replaced ${details.replacements} occurrence${details.replacements === 1 ? '' : 's'}`
      : `replaced ${details.replacements} occurrence${details.replacements === 1 ? '' : 's'} at line ${details.firstChangedLine}`
  }

  if (phase === 'update') {
    return 'streaming output'
  }

  const details = (output as BashToolOutput).details
  return typeof details.exitCode === 'number' ? `exit ${details.exitCode}` : 'command completed'
}

export function normalizeToolResult(
  toolName: ToolCallName,
  output: unknown,
  options: { phase?: 'update' | 'end' } = {}
): {
  status: ToolCallStatus
  outputSummary?: string
  cwd?: string
  error?: string
  details?: ToolCallDetailsSnapshot
} {
  const phase = options.phase ?? 'end'
  const typedOutput = output as AgentToolOutput
  const error = getOutputError(output)

  return {
    status: phase === 'update' ? 'running' : error ? 'failed' : 'completed',
    outputSummary: summarizeToolOutput(toolName, output, { phase }),
    ...(typedOutput.metadata.cwd ? { cwd: typedOutput.metadata.cwd } : {}),
    ...(error ? { error } : {}),
    ...(typedOutput.details ? { details: typedOutput.details } : {})
  }
}

function toModelOutput(output: AgentToolOutput):
  | {
      type: 'content'
      value: ToolContentBlock[]
    }
  | {
      type: 'error-text'
      value: string
    } {
  if (output.error) {
    return {
      type: 'error-text',
      value: flattenToolContent(output.content) || output.error
    }
  }

  return {
    type: 'content',
    value: output.content
  }
}

export function createAgentToolSet(context: AgentToolContext): ToolSet {
  const workspaceHint = `Relative paths resolve from ${context.workspacePath}.`

  return {
    read: tool({
      description: `Read a text file from the current thread workspace or an absolute path. ${workspaceHint} Use offset as a 0-based line continuation cursor.`,
      inputSchema: readToolInputSchema,
      toModelOutput: ({ output }) => toModelOutput(output),
      execute: (input) => runReadTool(input, context)
    }),
    write: tool({
      description: `Write a text file in the current thread workspace or at an absolute path. ${workspaceHint} Parent directories are created automatically and existing files are overwritten.`,
      inputSchema: writeToolInputSchema,
      toModelOutput: ({ output }) => toModelOutput(output),
      execute: (input) => runWriteTool(input, context)
    }),
    edit: tool({
      description: `Edit an existing text file with a targeted oldText -> newText replacement. ${workspaceHint} The edit fails when oldText is missing or ambiguous.`,
      inputSchema: editToolInputSchema,
      toModelOutput: ({ output }) => toModelOutput(output),
      execute: (input) => runEditTool(input, context)
    }),
    bash: tool({
      description: `Run a shell command with cwd set to ${context.workspacePath}. Use timeout in seconds. A minimal hard guard blocks obviously catastrophic destructive commands such as rm -rf /.`,
      inputSchema: bashToolInputSchema,
      toModelOutput: ({ output }) => toModelOutput(output),
      execute: (input, options) =>
        streamBashTool(input, context, {
          abortSignal: options.abortSignal,
          toolCallId: options.toolCallId
        })
    })
  }
}
