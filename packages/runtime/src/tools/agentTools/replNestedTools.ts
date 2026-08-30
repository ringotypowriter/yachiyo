import { statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

import type { ToolExecutionOptions } from 'ai'

import { resolvePathWithinWorkspace, type AgentToolOutput } from './shared.ts'

export const REPL_TOOL_NAMES = ['jsRepl', 'pyRepl'] as const

type ReplToolName = (typeof REPL_TOOL_NAMES)[number]

export type ReplCwdResolution = { resolved: string } | { error: string }

interface ExecuteNestedReplToolOptions {
  replName: ReplToolName
  toolName: string
  input: unknown
  cwd: string
  resolveTool: (name: string) => unknown
  executionOptions: ToolExecutionOptions
  signal: AbortSignal
}

export function isReplToolName(name: string): name is ReplToolName {
  return REPL_TOOL_NAMES.some((replName) => replName === name)
}

export function resolveReplToolCwd(
  workspacePath: string,
  requested: string | undefined
): ReplCwdResolution {
  if (!requested || requested === '.') return { resolved: workspacePath }
  const resolved = resolvePathWithinWorkspace(workspacePath, requested)
  if (!resolved) {
    return {
      error: `Invalid cwd ${JSON.stringify(requested)} — must be a relative path inside the workspace.`
    }
  }
  try {
    const info = statSync(resolved)
    if (!info.isDirectory()) {
      return { error: `Invalid cwd ${JSON.stringify(requested)} — not a directory.` }
    }
  } catch {
    return { error: `Invalid cwd ${JSON.stringify(requested)} — directory does not exist.` }
  }
  return { resolved }
}

export function createReplToolExecutionOptions(
  replName: ReplToolName,
  signal?: AbortSignal
): ToolExecutionOptions {
  return {
    toolCallId: `${replCallPrefix(replName)}-${crypto.randomUUID()}`,
    messages: [],
    ...(signal ? { abortSignal: signal } : {})
  }
}

export async function executeNestedReplTool({
  replName,
  toolName,
  input,
  cwd,
  resolveTool,
  executionOptions,
  signal
}: ExecuteNestedReplToolOptions): Promise<unknown> {
  const tool = isReplToolName(toolName) ? undefined : resolveTool(toolName)
  if (!tool) {
    throw new Error(`Tool ${JSON.stringify(toolName)} is not available.`)
  }
  if (
    (typeof tool !== 'object' && typeof tool !== 'function') ||
    !('execute' in tool) ||
    typeof tool.execute !== 'function'
  ) {
    throw new Error('The requested tool has no executable implementation.')
  }

  const options: ToolExecutionOptions = {
    ...executionOptions,
    toolCallId: `${replCallPrefix(replName)}-${crypto.randomUUID()}`,
    abortSignal: signal
  }
  const rewrittenInput = rewriteNestedToolInput(toolName, input, cwd)
  const execution = Reflect.apply(tool.execute, tool, [rewrittenInput, options]) as unknown
  const output = isAsyncIterable(execution)
    ? await consumeAsyncIterable(execution)
    : await Promise.resolve(execution)
  return normalizeNestedToolOutput(output)
}

function replCallPrefix(name: ReplToolName): string {
  return name === 'jsRepl' ? 'js-repl' : 'py-repl'
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  )
}

async function consumeAsyncIterable(iterable: AsyncIterable<unknown>): Promise<unknown> {
  let output: unknown
  for await (const value of iterable) output = value
  return output
}

function isAgentToolOutput(value: unknown): value is AgentToolOutput {
  return (
    value !== null &&
    typeof value === 'object' &&
    'content' in value &&
    Array.isArray(value.content) &&
    'details' in value &&
    'metadata' in value
  )
}

function normalizeNestedToolOutput(output: unknown): unknown {
  if (!isAgentToolOutput(output)) return output
  if (output.error) throw new Error(output.error)

  const text = output.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
  const images = output.content
    .filter(
      (block): block is { type: 'image-data'; data: string; mediaType: string } =>
        block.type === 'image-data'
    )
    .map((block) => ({ data: block.data, mediaType: block.mediaType }))
  const hasDetails =
    output.details !== undefined &&
    output.details !== null &&
    Object.keys(output.details as object).length > 0

  if (!hasDetails && images.length === 0) return text
  return {
    text,
    ...(hasDetails ? { details: output.details } : {}),
    ...(images.length > 0 ? { images } : {})
  }
}

function rewriteNestedToolInput(name: string, input: unknown, cwd: string): unknown {
  if (name !== 'bash') return rewriteRelativePath(input, cwd)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  if (!('command' in input) || typeof input.command !== 'string') return input
  return { ...input, command: `cd ${quoteShell(cwd)} && ${input.command}` }
}

function rewriteRelativePath(input: unknown, cwd: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  if (!('path' in input) || typeof input.path !== 'string') return input
  if (isAbsolute(input.path) || input.path.startsWith('~')) return input
  return { ...input, path: resolvePath(cwd, input.path) }
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
