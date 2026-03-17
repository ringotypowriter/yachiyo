import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import type { ToolCallName, ToolCallStatus } from '../../shared/yachiyo/protocol'

const execFileAsync = promisify(execFile)

const DEFAULT_READ_LINE_COUNT = 200
const DEFAULT_READ_MAX_CHARS = 16_000
const DEFAULT_BASH_TIMEOUT_MS = 30_000
const MAX_BASH_TIMEOUT_MS = 120_000
const MAX_BASH_OUTPUT_CHARS = 20_000

const readToolInputSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  lineCount: z.number().int().min(1).max(500).optional(),
  maxChars: z.number().int().min(256).max(32_000).optional()
})

const writeToolInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  overwrite: z.boolean().optional()
})

const editToolInputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().optional()
})

const bashToolInputSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(MAX_BASH_TIMEOUT_MS).optional()
})

type ReadToolInput = z.infer<typeof readToolInputSchema>
type WriteToolInput = z.infer<typeof writeToolInputSchema>
type EditToolInput = z.infer<typeof editToolInputSchema>
type BashToolInput = z.infer<typeof bashToolInputSchema>

interface AgentToolContext {
  workspacePath: string
}

interface BaseToolOutput {
  ok: boolean
}

export interface ReadToolOutput extends BaseToolOutput {
  path: string
  workspacePath: string
  startLine: number
  endLine: number
  totalLines: number
  totalChars: number
  truncated: boolean
  content?: string
  error?: string
}

export interface WriteToolOutput extends BaseToolOutput {
  path: string
  bytesWritten?: number
  created?: boolean
  overwritten?: boolean
  error?: string
}

export interface EditToolOutput extends BaseToolOutput {
  path: string
  replacements?: number
  error?: string
}

export interface BashToolOutput extends BaseToolOutput {
  command: string
  cwd: string
  exitCode?: number
  stdout: string
  stderr: string
  blocked?: boolean
  timedOut?: boolean
  error?: string
}

export type AgentToolOutput = ReadToolOutput | WriteToolOutput | EditToolOutput | BashToolOutput

interface ExecFileError extends Error {
  code?: number | string | null
  stdout?: string
  stderr?: string
  killed?: boolean
}

interface BashRunnerInput {
  command: string
  cwd: string
  timeoutMs: number
  abortSignal?: AbortSignal
}

interface BashRunnerResult {
  stdout: string
  stderr: string
  exitCode: number
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

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`
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

const defaultBashRunner: BashRunner = async ({ abortSignal, command, cwd, timeoutMs }) => {
  const result = await execFileAsync('/bin/zsh', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1_000_000,
    signal: abortSignal,
    timeout: timeoutMs
  })

  return {
    exitCode: 0,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

export async function runReadTool(
  input: ReadToolInput,
  context: AgentToolContext
): Promise<ReadToolOutput> {
  const resolvedPath = resolveToolPath(context.workspacePath, input.path)

  try {
    const rawContent = await readFile(resolvedPath, 'utf8')
    const totalChars = rawContent.length
    const totalLines = rawContent.length === 0 ? 0 : rawContent.split(/\r?\n/).length
    const startLine = input.startLine ?? 1
    const lineCount = input.lineCount ?? DEFAULT_READ_LINE_COUNT
    const maxChars = input.maxChars ?? DEFAULT_READ_MAX_CHARS
    const lines = rawContent.split(/\r?\n/)
    const selectedLines = lines.slice(startLine - 1, startLine - 1 + lineCount)
    const excerpt = selectedLines.join('\n')
    const truncated =
      selectedLines.length < Math.max(lines.length - (startLine - 1), 0) ||
      excerpt.length > maxChars
    const content = truncateText(excerpt, maxChars)
    const endLine =
      selectedLines.length === 0 ? startLine - 1 : startLine + selectedLines.length - 1

    return {
      ok: true,
      path: resolvedPath,
      workspacePath: context.workspacePath,
      startLine,
      endLine,
      totalLines,
      totalChars,
      truncated,
      content
    }
  } catch (error) {
    return {
      ok: false,
      path: resolvedPath,
      workspacePath: context.workspacePath,
      startLine: input.startLine ?? 1,
      endLine: input.startLine ?? 0,
      totalLines: 0,
      totalChars: 0,
      truncated: false,
      error: error instanceof Error ? error.message : 'Unable to read file.'
    }
  }
}

export async function runWriteTool(
  input: WriteToolInput,
  context: AgentToolContext
): Promise<WriteToolOutput> {
  const resolvedPath = resolveToolPath(context.workspacePath, input.path)
  const exists = await hasAccess(resolvedPath)

  if (exists && !input.overwrite) {
    return {
      ok: false,
      path: resolvedPath,
      error: 'File already exists. Set overwrite=true to replace it.'
    }
  }

  try {
    await mkdir(dirname(resolvedPath), { recursive: true })
    await writeFile(resolvedPath, input.content, 'utf8')

    return {
      ok: true,
      path: resolvedPath,
      bytesWritten: Buffer.byteLength(input.content, 'utf8'),
      created: !exists,
      overwritten: exists
    }
  } catch (error) {
    return {
      ok: false,
      path: resolvedPath,
      error: error instanceof Error ? error.message : 'Unable to write file.'
    }
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
      return {
        ok: false,
        path: resolvedPath,
        error: 'Search text was not found in the target file.'
      }
    }

    if (!input.replaceAll && occurrences > 1) {
      return {
        ok: false,
        path: resolvedPath,
        error:
          'Search text matched multiple locations. Set replaceAll=true or make oldText more specific.'
      }
    }

    const nextContent = input.replaceAll
      ? original.split(input.oldText).join(input.newText)
      : original.replace(input.oldText, input.newText)

    await writeFile(resolvedPath, nextContent, 'utf8')

    return {
      ok: true,
      path: resolvedPath,
      replacements: input.replaceAll ? occurrences : 1
    }
  } catch (error) {
    return {
      ok: false,
      path: resolvedPath,
      error: error instanceof Error ? error.message : 'Unable to edit file.'
    }
  }
}

export async function runBashTool(
  input: BashToolInput,
  context: AgentToolContext,
  options: { abortSignal?: AbortSignal; runCommand?: BashRunner } = {}
): Promise<BashToolOutput> {
  const command = input.command.trim()
  const timeoutMs = input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS

  if (isBlockedBashCommand(command)) {
    return {
      ok: false,
      command,
      cwd: context.workspacePath,
      stdout: '',
      stderr: '',
      blocked: true,
      error: 'Blocked an obviously catastrophic destructive command.'
    }
  }

  try {
    const result = await (options.runCommand ?? defaultBashRunner)({
      abortSignal: options.abortSignal,
      command,
      cwd: context.workspacePath,
      timeoutMs
    })

    return {
      ok: true,
      command,
      cwd: context.workspacePath,
      exitCode: result.exitCode,
      stdout: truncateText(result.stdout, MAX_BASH_OUTPUT_CHARS),
      stderr: truncateText(result.stderr, MAX_BASH_OUTPUT_CHARS)
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }

    const execError = error as ExecFileError
    const exitCode =
      typeof execError.code === 'number'
        ? execError.code
        : execError.code === null || execError.code === undefined
          ? undefined
          : Number.isNaN(Number(execError.code))
            ? undefined
            : Number(execError.code)

    return {
      ok: false,
      command,
      cwd: context.workspacePath,
      exitCode,
      stdout: truncateText(execError.stdout ?? '', MAX_BASH_OUTPUT_CHARS),
      stderr: truncateText(execError.stderr ?? '', MAX_BASH_OUTPUT_CHARS),
      timedOut: Boolean(execError.killed),
      error: execError.message
    }
  }
}

export function summarizeToolInput(toolName: ToolCallName, input: unknown): string {
  if (toolName === 'bash') {
    const command =
      typeof input === 'object' && input !== null && 'command' in input ? input.command : ''
    return truncateText(typeof command === 'string' ? command : '', 160)
  }

  const path = typeof input === 'object' && input !== null && 'path' in input ? input.path : ''
  return typeof path === 'string' && path.trim().length > 0 ? path : toolName
}

export function summarizeToolOutput(toolName: ToolCallName, output: unknown): string {
  if (toolName === 'read') {
    const result = output as Partial<ReadToolOutput>
    if (!result.ok) {
      return result.error ?? 'Read failed.'
    }
    const lineSummary =
      typeof result.startLine === 'number' && typeof result.endLine === 'number'
        ? `lines ${result.startLine}-${result.endLine}`
        : 'read completed'
    return result.truncated ? `${lineSummary} (truncated)` : lineSummary
  }

  if (toolName === 'write') {
    const result = output as Partial<WriteToolOutput>
    if (!result.ok) {
      return result.error ?? 'Write failed.'
    }
    return result.overwritten
      ? `overwrote ${result.bytesWritten ?? 0} bytes`
      : `wrote ${result.bytesWritten ?? 0} bytes`
  }

  if (toolName === 'edit') {
    const result = output as Partial<EditToolOutput>
    if (!result.ok) {
      return result.error ?? 'Edit failed.'
    }
    return `replaced ${result.replacements ?? 0} occurrence${result.replacements === 1 ? '' : 's'}`
  }

  const result = output as Partial<BashToolOutput>
  if (!result.ok) {
    if (result.blocked) {
      return result.error ?? 'Command blocked.'
    }
    if (typeof result.exitCode === 'number') {
      return `exit ${result.exitCode}`
    }
    return result.error ?? 'Command failed.'
  }

  return `exit ${result.exitCode ?? 0}`
}

export function getToolResultStatus(output: unknown): ToolCallStatus {
  return typeof output === 'object' && output !== null && 'ok' in output && output.ok === false
    ? 'failed'
    : 'completed'
}

export function extractToolCwd(toolName: ToolCallName, output: unknown): string | undefined {
  if (toolName !== 'bash') {
    return undefined
  }

  return typeof output === 'object' &&
    output !== null &&
    'cwd' in output &&
    typeof output.cwd === 'string'
    ? output.cwd
    : undefined
}

export function createAgentToolSet(context: AgentToolContext): ToolSet {
  const workspaceHint = `Relative paths resolve from ${context.workspacePath}.`

  return {
    read: tool({
      description: `Read a text file from the current thread workspace or an absolute path. ${workspaceHint} Reads are bounded by line count and character count.`,
      inputSchema: readToolInputSchema,
      execute: (input) => runReadTool(input, context)
    }),
    write: tool({
      description: `Write a text file in the current thread workspace or at an absolute path. ${workspaceHint} Set overwrite=true to intentionally replace an existing file.`,
      inputSchema: writeToolInputSchema,
      execute: (input) => runWriteTool(input, context)
    }),
    edit: tool({
      description: `Edit an existing text file with targeted search/replace changes instead of rewriting the whole file. ${workspaceHint}`,
      inputSchema: editToolInputSchema,
      execute: (input) => runEditTool(input, context)
    }),
    bash: tool({
      description: `Run a shell command with cwd set to ${context.workspacePath}. Use it directly for normal local work. A minimal hard guard blocks obviously catastrophic destructive commands such as rm -rf /.`,
      inputSchema: bashToolInputSchema,
      execute: (input, options) => runBashTool(input, context, { abortSignal: options.abortSignal })
    })
  }
}
