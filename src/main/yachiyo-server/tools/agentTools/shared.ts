import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { z } from 'zod'

import type {
  BashToolCallDetails,
  EditToolCallDetails,
  GlobToolCallDetails,
  GrepToolCallDetails,
  ReadToolCallDetails,
  SkillsReadToolCallDetails,
  ToolCallDetailsSnapshot,
  ToolCallName,
  WebReadToolCallDetails,
  WebSearchToolCallDetails,
  WriteToolCallDetails
} from '../../../../shared/yachiyo/protocol.ts'
import { DEFAULT_WEB_READ_CONTENT_FORMAT } from '../../../../shared/yachiyo/protocol.ts'

export const DEFAULT_READ_LIMIT = 200
export const MAX_READ_LIMIT = 500
export const DEFAULT_READ_MAX_BYTES = 16_000

export const DEFAULT_BASH_TIMEOUT_SECONDS = 30
export const MAX_BASH_TIMEOUT_SECONDS = 120
export const MAX_BASH_MODEL_OUTPUT_CHARS = 20_000
export const MAX_BASH_DETAILS_OUTPUT_CHARS = 8_000
export const DEFAULT_SEARCH_LIMIT = 50
export const MAX_SEARCH_LIMIT = 200
export const DEFAULT_WEB_READ_FORMAT = DEFAULT_WEB_READ_CONTENT_FORMAT
export const DEFAULT_WEB_SEARCH_LIMIT = 5
export const MAX_WEB_SEARCH_LIMIT = 10

export const readToolInputSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional()
})

export const writeToolInputSchema = z.object({
  path: z.string().min(1),
  content: z.string()
})

export const editToolInputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string()
})

export const bashToolInputSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().int().min(1).max(MAX_BASH_TIMEOUT_SECONDS).optional()
})

export const grepToolInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  literal: z.boolean().optional(),
  caseSensitive: z.boolean().optional()
})

export const globToolInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional()
})

export const webReadToolInputSchema = z.object({
  url: z.string().min(1),
  format: z.enum(['markdown', 'html']).optional()
})

export const webSearchToolInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_WEB_SEARCH_LIMIT).optional()
})

export const skillsReadToolInputSchema = z.object({
  names: z.array(z.string().min(1)).min(1).max(20),
  includeContent: z.boolean().optional()
})

export type ReadToolInput = z.infer<typeof readToolInputSchema>
export type WriteToolInput = z.infer<typeof writeToolInputSchema>
export type EditToolInput = z.infer<typeof editToolInputSchema>
export type BashToolInput = z.infer<typeof bashToolInputSchema>
export type GrepToolInput = z.infer<typeof grepToolInputSchema>
export type GlobToolInput = z.infer<typeof globToolInputSchema>
export type WebReadToolInput = z.infer<typeof webReadToolInputSchema>
export type WebSearchToolInput = z.infer<typeof webSearchToolInputSchema>
export type SkillsReadToolInput = z.infer<typeof skillsReadToolInputSchema>

export interface AgentToolContext {
  enabledTools?: ToolCallName[]
  workspacePath: string
  /** When true, file tools are sandboxed to the workspace — no absolute path escapes. */
  sandboxed?: boolean
}

export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image-data'; data: string; mediaType: string }

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
export type GrepToolOutput = AgentToolResult<GrepToolCallDetails>
export type GlobToolOutput = AgentToolResult<GlobToolCallDetails>
export type WebReadToolOutput = AgentToolResult<WebReadToolCallDetails>
export type WebSearchToolOutput = AgentToolResult<WebSearchToolCallDetails>
export type SkillsReadToolOutput = AgentToolResult<SkillsReadToolCallDetails>

export type AgentToolOutput =
  | ReadToolOutput
  | WriteToolOutput
  | EditToolOutput
  | BashToolOutput
  | GrepToolOutput
  | GlobToolOutput
  | WebReadToolOutput
  | WebSearchToolOutput
  | SkillsReadToolOutput

export interface BashRunnerInput {
  command: string
  cwd: string
  timeoutSeconds: number
  abortSignal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export interface BashRunnerResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
}

export type BashRunner = (input: BashRunnerInput) => Promise<BashRunnerResult>

export function expandTilde(targetPath: string): string {
  if (targetPath === '~' || targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
    return join(homedir(), targetPath.slice(1))
  }
  return targetPath
}

export function resolveToolPath(workspacePath: string, targetPath: string): string {
  // Strip surrounding quotes that models sometimes add for paths containing spaces.
  const unquoted = targetPath.trim().replace(/^(['"`])(.*)\1$/, '$2')
  const expanded = expandTilde(unquoted)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(workspacePath, expanded)
}

/**
 * Resolve a tool path, respecting the sandbox flag.
 * When sandboxed, paths that escape the workspace return an error string.
 */
export function resolveSandboxedToolPath(
  context: AgentToolContext,
  targetPath: string
): { resolved: string } | { error: string } {
  if (!context.sandboxed) {
    return { resolved: resolveToolPath(context.workspacePath, targetPath) }
  }
  const result = resolvePathWithinWorkspace(context.workspacePath, targetPath)
  if (result) {
    return { resolved: result }
  }
  return { error: `Access denied — path is outside the workspace. Only files within ${context.workspacePath} are accessible.` }
}

export function resolvePathWithinWorkspace(
  workspacePath: string,
  targetPath: string
): string | undefined {
  const resolvedWorkspacePath = resolve(workspacePath)
  const resolvedTargetPath = resolve(resolvedWorkspacePath, targetPath)
  const workspaceRelativePath = relative(resolvedWorkspacePath, resolvedTargetPath)

  if (
    workspaceRelativePath === '' ||
    (!workspaceRelativePath.startsWith('..') && !isAbsolute(workspaceRelativePath))
  ) {
    return resolvedTargetPath
  }

  return undefined
}

export function hasAccess(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

export function countOccurrences(haystack: string, needle: string): number {
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

export function countNewlines(value: string): number {
  return value.length === 0 ? 0 : (value.match(/\n/g) ?? []).length
}

export function textContent(text: string): ToolContentBlock[] {
  return text.length === 0 ? [] : [{ type: 'text', text }]
}

export function imageDataContent(data: string, mediaType: string): ToolContentBlock[] {
  return [{ type: 'image-data', data, mediaType }]
}

export function flattenToolContent(content: ToolContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export function truncateUtf8ByBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')

  if (bytes.length <= maxBytes) {
    return value
  }

  return Buffer.from(bytes.subarray(0, maxBytes)).toString('utf8')
}

export function takeTail(value: string, maxChars: number): { text: string; truncated: boolean } {
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

export function truncateForDetails(value: string): { text: string; truncated: boolean } {
  return takeTail(value, MAX_BASH_DETAILS_OUTPUT_CHARS)
}

export function toToolModelOutput(output: unknown):
  | {
      type: 'content'
      value: ToolContentBlock[]
    }
  | {
      type: 'error-text'
      value: string
    } {
  const typedOutput = output as AgentToolOutput

  if (typedOutput.error) {
    return {
      type: 'error-text',
      value: flattenToolContent(typedOutput.content) || typedOutput.error
    }
  }

  return {
    type: 'content',
    value: typedOutput.content
  }
}
