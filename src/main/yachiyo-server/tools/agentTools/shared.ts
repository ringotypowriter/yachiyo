import type { ChildProcess } from 'node:child_process'
import { access, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { z } from 'zod'

import type {
  AskUserToolCallDetails,
  BashToolCallDetails,
  EditToolCallDetails,
  GlobToolCallDetails,
  GrepToolCallDetails,
  JsReplToolCallDetails,
  ReadToolCallDetails,
  SkillsReadToolCallDetails,
  ToolCallDetailsSnapshot,
  ToolCallName,
  WebReadToolCallDetails,
  WebSearchToolCallDetails,
  WriteToolCallDetails
} from '../../../../shared/yachiyo/protocol.ts'
import { DEFAULT_WEB_READ_CONTENT_FORMAT } from '../../../../shared/yachiyo/protocol.ts'
import type { ReadRecordCache } from './readRecordCache.ts'

/**
/**
 * Race a promise against an AbortSignal — rejects with an AbortError when the
 * signal fires. Useful for wrapping calls that don't natively accept a signal.
 */
export async function raceAgainstSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // Register listener first to avoid a TOCTOU race: if we check signal.aborted
  // before registering, the signal could abort between the check and the listener
  // registration, and we'd miss the event permanently.
  let onAbort: (() => void) | undefined
  let cleanup: (() => void) | undefined

  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = (): void => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    cleanup = () => signal.removeEventListener('abort', onAbort!)

    // Signal was already aborted before we could register — fire immediately.
    if (signal.aborted) {
      onAbort()
    }
  })

  try {
    return await Promise.race([promise, abortPromise])
  } finally {
    cleanup?.()
  }
}

export const DEFAULT_READ_LIMIT = 200
export const MAX_READ_LIMIT = 500
export const DEFAULT_READ_MAX_BYTES = 16_000

export const DEFAULT_BASH_TIMEOUT_SECONDS = 30
export const MAX_BASH_TIMEOUT_SECONDS = 300
export const MAX_BASH_MODEL_OUTPUT_CHARS = 20_000
export const MAX_BASH_DETAILS_OUTPUT_CHARS = 8_000
export const DEFAULT_SEARCH_LIMIT = 50
export const MAX_SEARCH_LIMIT = 200
export const MAX_GREP_CONTEXT_LINES = 30
export const DEFAULT_WEB_READ_FORMAT = DEFAULT_WEB_READ_CONTENT_FORMAT
export const DEFAULT_WEB_SEARCH_LIMIT = 10
export const MAX_WEB_SEARCH_LIMIT = 30

function applyShadowFallbacks(value: unknown, mappings: Record<string, string>): unknown {
  if (typeof value !== 'object' || value === null) return value
  const obj = value as Record<string, unknown>
  const result = { ...obj }
  for (const [alias, canonical] of Object.entries(mappings)) {
    if (alias in result && !(canonical in result)) {
      result[canonical] = result[alias]
      delete result[alias]
    }
  }
  return result
}

export function withShadowFallbacks<T extends z.ZodTypeAny>(
  schema: T,
  mappings: Record<string, string>
): z.ZodType<z.infer<T>> {
  return z.preprocess((val) => applyShadowFallbacks(val, mappings), schema)
}

export const readToolInputSchema = withShadowFallbacks(
  z.object({
    path: z.string().min(1),
    offset: z.number().int().min(0).default(1),
    limit: z.number().int().min(1).max(MAX_READ_LIMIT).default(DEFAULT_READ_LIMIT),
    focus: z
      .string()
      .optional()
      .describe(
        'For image files: a specific question about the image content. Returns a text description instead of the image.'
      )
  }),
  { filePath: 'path' }
)

export const writeToolInputSchema = withShadowFallbacks(
  z.object({
    path: z.string().min(1),
    content: z.string()
  }),
  { filePath: 'path' }
)

function getMeaningfulLineArrayText(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const text = value.join('\n')
  return text.length > 0 ? text : undefined
}

function getProvidedLineArrayText(value: unknown): string | undefined {
  return Array.isArray(value) && value.length > 0 ? value.join('\n') : undefined
}

export const editSpecSchema = z
  .object({
    oldText: z
      .string()
      .min(1)
      .optional()
      .describe('Exact search text. For multiline snippets, prefer oldLines.'),
    oldLines: z
      .array(z.string())
      .optional()
      .describe('Exact search text as lines joined with LF; avoids \\n escaping mistakes.'),
    newText: z
      .string()
      .optional()
      .describe('Replacement text. For multiline snippets, prefer newLines.'),
    newLines: z
      .array(z.string())
      .optional()
      .describe('Replacement text as lines joined with LF; [] is ignored, [""] clears.'),
    replace_all: z.boolean().default(false)
  })
  .superRefine((data, ctx) => {
    const oldText = hasMeaningfulOldText(data.oldText) ? data.oldText : undefined
    const oldLinesText = getMeaningfulLineArrayText(data.oldLines)
    const newText = hasProvidedNewText(data.newText) ? data.newText : undefined
    const newLinesText = getProvidedLineArrayText(data.newLines)
    const hasSearchSource = oldText !== undefined || oldLinesText !== undefined
    const hasReplacementSource = newText !== undefined || newLinesText !== undefined
    const hasSearchConflict =
      oldText !== undefined && oldLinesText !== undefined && oldText !== oldLinesText
    const hasReplacementConflict =
      newText !== undefined &&
      newLinesText !== undefined &&
      newText !== '' &&
      newText !== newLinesText

    if (!hasSearchSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['oldText'],
        message: 'oldText or oldLines is required and must produce non-empty search text.'
      })
    }
    if (hasSearchConflict) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['oldLines'],
        message: 'oldText and oldLines must match when both are provided.'
      })
    }
    if (!hasReplacementSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newText'],
        message: 'newText or newLines is required.'
      })
    }
    if (hasReplacementConflict) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newLines'],
        message: 'newText and newLines must match when both are provided.'
      })
    }
  })

export const replaceLinesSchema = z.object({
  start: z.number().int().min(1),
  end: z.number().int().min(1)
})

const emptyReplaceLinesSchema = z.object({}).strict()
const editReplaceLinesInputSchema = z
  .union([replaceLinesSchema, emptyReplaceLinesSchema, z.null()])
  .optional()

function hasMeaningfulOldText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function hasProvidedNewText(value: unknown): value is string {
  return typeof value === 'string'
}

function hasMeaningfulReplaceAll(value: unknown): value is true {
  return value === true
}

function hasMeaningfulReplaceLines(value: unknown): value is z.infer<typeof replaceLinesSchema> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'start' in value &&
    'end' in value &&
    typeof value.start === 'number' &&
    typeof value.end === 'number'
  )
}

function hasMeaningfulEdits(value: unknown): value is z.infer<typeof editSpecSchema>[] {
  return Array.isArray(value) && value.length > 0
}

export const editToolInputSchema = withShadowFallbacks(
  z
    .object({
      mode: z.enum(['inline', 'range', 'batch']),
      path: z.string().min(1),
      oldText: z
        .string()
        .optional()
        .describe('Exact search text. For multiline snippets, prefer oldLines.'),
      oldLines: z
        .array(z.string())
        .optional()
        .describe('Exact search text as lines joined with LF; avoids \\n escaping mistakes.'),
      newText: z
        .string()
        .optional()
        .describe('Replacement text. For multiline snippets, prefer newLines.'),
      newLines: z
        .array(z.string())
        .optional()
        .describe('Replacement text as lines joined with LF; [] is ignored, [""] clears.'),
      replace_all: z.boolean().optional(),
      replaceLines: editReplaceLinesInputSchema,
      edits: z.array(editSpecSchema).max(50).optional()
    })
    .strict()
    .superRefine((data, ctx) => {
      const oldText = hasMeaningfulOldText(data.oldText) ? data.oldText : undefined
      const oldLinesText = getMeaningfulLineArrayText(data.oldLines)
      const newText = hasProvidedNewText(data.newText) ? data.newText : undefined
      const newLinesText = getProvidedLineArrayText(data.newLines)
      const hasOldText = oldText !== undefined
      const hasOldLines = oldLinesText !== undefined
      const hasNewText = newText !== undefined
      const hasNewLines = newLinesText !== undefined
      const hasReplaceLines = hasMeaningfulReplaceLines(data.replaceLines)
      const hasEdits = hasMeaningfulEdits(data.edits)
      const hasConflictingReplaceAll = hasMeaningfulReplaceAll(data.replace_all)
      const hasSearchSource = hasOldText || hasOldLines
      const hasReplacementSource = hasNewText || hasNewLines
      const hasSearchConflict = hasOldText && hasOldLines && oldText !== oldLinesText
      const hasReplacementConflict =
        hasNewText && hasNewLines && newText !== '' && newText !== newLinesText

      if (data.mode === 'inline') {
        if (!hasSearchSource) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['oldText'],
            message:
              'oldText or oldLines is required and must produce non-empty search text when mode is "inline".'
          })
        }
        if (hasSearchConflict) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['oldLines'],
            message: 'oldText and oldLines must match when both are provided.'
          })
        }
        if (!hasReplacementSource) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['newText'],
            message: 'newText or newLines is required when mode is "inline".'
          })
        }
        if (hasReplacementConflict) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['newLines'],
            message: 'newText and newLines must match when both are provided.'
          })
        }
        if (hasReplaceLines) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['replaceLines'],
            message: 'replaceLines must be omitted or empty unless mode is "range".'
          })
        }
        if (hasEdits) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['edits'],
            message: 'edits must be omitted or empty unless mode is "batch".'
          })
        }
        return
      }

      if (data.mode === 'range') {
        if (!hasReplaceLines) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['replaceLines'],
            message: 'replaceLines is required when mode is "range".'
          })
        }
        if (!hasReplacementSource) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['newText'],
            message: 'newText or newLines is required when mode is "range".'
          })
        }
        if (hasReplacementConflict) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['newLines'],
            message: 'newText and newLines must match when both are provided.'
          })
        }
        if (hasOldText) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['oldText'],
            message: 'oldText must be omitted or empty unless mode is "inline".'
          })
        }
        if (hasOldLines) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['oldLines'],
            message: 'oldLines must be omitted or empty unless mode is "inline".'
          })
        }
        if (hasEdits) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['edits'],
            message: 'edits must be omitted or empty unless mode is "batch".'
          })
        }
        if (hasConflictingReplaceAll) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['replace_all'],
            message: 'replace_all must be omitted or false unless mode is "inline".'
          })
        }
        return
      }

      if (!hasEdits) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edits'],
          message: 'edits is required and must be non-empty when mode is "batch".'
        })
      }
    }),
  { filePath: 'path' }
)

export const bashToolInputSchema = z.object({
  command: z.string().min(1),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_BASH_TIMEOUT_SECONDS)
    .default(DEFAULT_BASH_TIMEOUT_SECONDS),
  background: z.boolean().default(false)
})

export const DEFAULT_JSREPL_TIMEOUT_SECONDS = 30
export const MAX_JSREPL_TIMEOUT_SECONDS = 120

export const jsReplToolInputSchema = z.object({
  code: z.string().min(1),
  reset: z.boolean().default(true),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_JSREPL_TIMEOUT_SECONDS)
    .default(DEFAULT_JSREPL_TIMEOUT_SECONDS),
  cwd: z
    .string()
    .min(1)
    .refine(
      (value) => {
        if (isAbsolute(value)) return false
        if (value.startsWith('~')) return false
        const segments = value.split(/[\\/]/)
        return !segments.includes('..')
      },
      {
        message: 'cwd must be a relative path within the workspace (no "..", no absolute, no "~").'
      }
    )
    .optional()
})

export const grepToolInputSchema = withShadowFallbacks(
  z.object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
    literal: z.boolean().default(false),
    caseSensitive: z.boolean().default(true),
    include: z.string().min(1).optional(),
    context: z.number().int().min(0).max(MAX_GREP_CONTEXT_LINES).default(0),
    filesOnly: z.boolean().default(false)
  }),
  { filePath: 'path' }
)

export const globToolInputSchema = withShadowFallbacks(
  z.object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT)
  }),
  { filePath: 'path' }
)

export const webReadToolInputSchema = z.object({
  url: z.string().min(1),
  format: z.enum(['markdown', 'html']).default(DEFAULT_WEB_READ_FORMAT)
})

export const webSearchToolInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_WEB_SEARCH_LIMIT).default(DEFAULT_WEB_SEARCH_LIMIT)
})

export const skillsReadToolInputSchema = z.object({
  names: z.array(z.string().min(1)).min(1).max(20)
})

export type ReadToolInput = z.infer<typeof readToolInputSchema>
export type WriteToolInput = z.infer<typeof writeToolInputSchema>
export type EditSpec = z.infer<typeof editSpecSchema>
export type EditToolInput = z.infer<typeof editToolInputSchema>
export type BashToolInput = z.infer<typeof bashToolInputSchema>
export type JsReplToolInput = z.infer<typeof jsReplToolInputSchema>
export type GrepToolInput = z.infer<typeof grepToolInputSchema>
export type GlobToolInput = z.infer<typeof globToolInputSchema>
export type WebReadToolInput = z.infer<typeof webReadToolInputSchema>
export type WebSearchToolInput = z.infer<typeof webSearchToolInputSchema>
export type SkillsReadToolInput = z.infer<typeof skillsReadToolInputSchema>

export interface BackgroundBashTaskHandle {
  taskId: string
  command: string
  cwd: string
  logPath: string
  toolCallId?: string
}

export interface BackgroundBashAdoptionHandle extends BackgroundBashTaskHandle {
  /** Already-running child process to adopt. Manager attaches its own log listeners. */
  child: ChildProcess
  /** Output already buffered by the foreground runner; written to the log first. */
  initialOutput: string
  /**
   * When true, `initialOutput` already lives at `logPath` (the foreground runner
   * spilled to disk before the timeout fired). The manager opens the log in append
   * mode and skips re-writing the initial bytes, but still replays them as live
   * log-append events so the renderer's session view stays in sync.
   */
  initialOutputAlreadyOnDisk?: boolean
}

export interface AgentToolContext {
  enabledTools?: ToolCallName[]
  workspacePath: string
  /** When true, file tools are sandboxed to the workspace — no absolute path escapes. */
  sandboxed?: boolean
  /** Shared read-record cache for the read-before-edit/write guard. */
  readRecordCache?: ReadRecordCache
  /** Snapshot tracker for capturing file states before modifications. */
  snapshotTracker?: import('../../services/fileSnapshot/snapshotTracker.ts').SnapshotTracker
  onBackgroundBashStarted?: (task: BackgroundBashTaskHandle) => Promise<void>
  /** Adopt a foreground bash child that exceeded its timeout, instead of killing it. */
  onBackgroundBashAdopted?: (task: BackgroundBashAdoptionHandle) => Promise<void>
  /** Image-to-text service for converting images when the model is not image-capable. */
  imageToTextService?: import('../../services/imageToText/imageToTextService.ts').ImageToTextService
  /** Whether the current thread model supports vision/image input. */
  isModelImageCapable?: boolean
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
export type JsReplToolOutput = AgentToolResult<JsReplToolCallDetails>
export type GrepToolOutput = AgentToolResult<GrepToolCallDetails>
export type GlobToolOutput = AgentToolResult<GlobToolCallDetails>
export type WebReadToolOutput = AgentToolResult<WebReadToolCallDetails>
export type WebSearchToolOutput = AgentToolResult<WebSearchToolCallDetails>
export type SkillsReadToolOutput = AgentToolResult<SkillsReadToolCallDetails>

export type AskUserToolOutput = AgentToolResult<AskUserToolCallDetails>

export type AgentToolOutput =
  | ReadToolOutput
  | WriteToolOutput
  | EditToolOutput
  | BashToolOutput
  | JsReplToolOutput
  | GrepToolOutput
  | GlobToolOutput
  | WebReadToolOutput
  | WebSearchToolOutput
  | SkillsReadToolOutput
  | AskUserToolOutput

export interface BashRunnerInput {
  command: string
  cwd: string
  timeoutSeconds: number
  /**
   * If provided, called when the timeout fires instead of killing the child.
   * Resolves to true if the caller has taken ownership of the child (the runner
   * must then detach its listeners and resolve with `lifted: true`).
   */
  onTimeoutLift?: (child: ChildProcess) => Promise<boolean>
  abortSignal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export interface BashRunnerResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
  /** Set when the timeout fired and the child was handed off to a background owner. */
  lifted?: boolean
}

export type BashRunner = (input: BashRunnerInput) => Promise<BashRunnerResult>

export function expandTilde(targetPath: string): string {
  if (targetPath === '~' || targetPath.startsWith('~/') || targetPath.startsWith('~\\')) {
    return join(homedir(), targetPath.slice(1))
  }
  return targetPath
}

export const FORBIDDEN_HUGE_SEARCH_ROOT_MESSAGE =
  'Refusing to search the filesystem root (`/`) or the home directory (`~`) — the scan range is too large. Pick a more specific subdirectory.'

// Block glob/grep from scanning the whole filesystem root or the user's home
// directory — those searches are prohibitively expensive and almost never the
// right answer. The workspace-equals-home edge case is allowed through so a
// project that actually lives at ~/ still works.
export function isForbiddenHugeSearchRoot(resolvedPath: string, workspacePath: string): boolean {
  const normalized = resolve(resolvedPath)
  if (normalized === resolve(workspacePath)) {
    return false
  }
  return normalized === resolve('/') || normalized === resolve(homedir())
}

export function resolveToolPath(workspacePath: string, targetPath: string): string {
  // Strip surrounding quotes that models sometimes add for paths containing spaces.
  const unquoted = targetPath.trim().replace(/^(['"`])(.*)\1$/, '$2')
  const expanded = expandTilde(unquoted)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(workspacePath, expanded)
}

// LLMs normalize U+202F (NARROW NO-BREAK SPACE, used in macOS time-format filenames)
// and similar Unicode space variants to regular U+0020 when copying paths from tool output.
// When a path doesn't resolve, walk each segment from the root and scan directory entries
// for names that match after normalizing all Unicode spaces to U+0020.
function normalizeUnicodeSpaces(s: string): string {
  return s.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, '\u0020')
}
export async function resolveUnicodeSpacePath(
  resolvedPath: string,
  signal?: AbortSignal
): Promise<string> {
  const statWithSignal = (p: string): Promise<unknown> =>
    signal ? raceAgainstSignal(stat(p), signal) : stat(p)
  const readdirWithSignal = (p: string): Promise<string[]> =>
    signal ? raceAgainstSignal(readdir(p), signal) : readdir(p)

  try {
    await statWithSignal(resolvedPath)
    return resolvedPath
  } catch {
    try {
      const segments = relative(resolve('/'), resolvedPath).split('/')
      let current = '/'

      for (const segment of segments) {
        const direct = join(current, segment)
        try {
          await statWithSignal(direct)
          current = direct
          continue
        } catch {
          // Segment doesn't exist literally — try fuzzy matching
        }

        const normalizedSegment = normalizeUnicodeSpaces(segment)
        try {
          const entries = await readdirWithSignal(current)
          const match = entries.find((e) => normalizeUnicodeSpaces(e) === normalizedSegment)
          if (match) {
            current = join(current, match)
          } else {
            return resolvedPath
          }
        } catch {
          return resolvedPath
        }
      }

      return current
    } catch {
      return resolvedPath
    }
  }
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
  return {
    error: `Access denied — path is outside the workspace. Only files within ${context.workspacePath} are accessible.`
  }
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
