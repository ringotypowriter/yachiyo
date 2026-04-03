import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

export type GrepBackendKind = 'rg' | 'typescript'
export type FileDiscoveryBackendKind = 'bfs' | 'typescript'
export type SearchBackendKind = GrepBackendKind | FileDiscoveryBackendKind

export interface SearchBackendCapabilities {
  grep: { available: GrepBackendKind }
  fileDiscovery: { available: FileDiscoveryBackendKind }
}

export interface SearchCommandInput {
  command: string
  args: string[]
  cwd: string
  maxLines?: number
  signal?: AbortSignal
}

export interface SearchCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  terminatedEarly?: boolean
}

export interface GrepSearchRequest {
  cwd: string
  pattern: string
  path?: string
  limit?: number
  literal?: boolean
  caseSensitive?: boolean
  /** Glob pattern to filter which files are searched (e.g. "*.ts", "*.{ts,tsx}"). */
  include?: string
  /** Number of context lines to show before and after each match. */
  context?: number
  signal?: AbortSignal
}

export interface GlobSearchRequest {
  cwd: string
  pattern: string
  path?: string
  limit?: number
  signal?: AbortSignal
}

export interface GrepSearchMatch {
  path: string
  line: number
  text: string
  /** Context lines before the match (populated when context > 0). */
  contextBefore?: string[]
  /** Context lines after the match (populated when context > 0). */
  contextAfter?: string[]
}

export interface GrepSearchResult {
  backend: GrepBackendKind
  rootPath: string
  matches: GrepSearchMatch[]
  truncated: boolean
}

export interface GlobSearchResult {
  backend: FileDiscoveryBackendKind
  rootPath: string
  paths: string[]
  truncated: boolean
}

export interface SearchService {
  readonly capabilities: SearchBackendCapabilities
  grep(input: GrepSearchRequest): Promise<GrepSearchResult>
  glob(input: GlobSearchRequest): Promise<GlobSearchResult>
}

export interface CreateSearchServiceOptions {
  /** Absolute path to the bundled rg binary. Omit to use TypeScript fallback. */
  rgPath?: string
  /** Absolute path to the bundled bfs binary. Omit to use TypeScript fallback. */
  bfsPath?: string
  /** Override for testing — replaces the default spawn-based command runner. */
  runCommand?: (input: SearchCommandInput) => Promise<SearchCommandResult>
}

type SearchErrorCode = 'backend-unavailable' | 'bad-input' | 'execution-failed'

class SearchBackendError extends Error {
  readonly code: SearchErrorCode

  constructor(code: SearchErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

const DEFAULT_RESULT_LIMIT = 50
const MAX_RESULT_LIMIT = 200
const MAX_SEARCH_STDERR_CHARS = 32_000
const MAX_SEARCH_STDOUT_CHARS = 1_000_000

export function createSearchService(options: CreateSearchServiceOptions = {}): SearchService {
  const rgPath = options.rgPath
  const bfsPath = options.bfsPath
  const runCommand = options.runCommand ?? runSearchCommand

  const capabilities: SearchBackendCapabilities = {
    grep: { available: rgPath ? 'rg' : 'typescript' },
    fileDiscovery: { available: bfsPath ? 'bfs' : 'typescript' }
  }

  return {
    capabilities,
    grep: async (input): Promise<GrepSearchResult> => {
      const request = normalizeGrepRequest(input)
      const rootPath = resolve(request.cwd, request.path)

      if (rgPath) {
        try {
          return await runRipgrepSearch({ executable: rgPath, request, rootPath, runCommand })
        } catch (error) {
          if (error instanceof SearchBackendError && error.code === 'backend-unavailable') {
            // Fall through to TypeScript
          } else {
            throw error
          }
        }
      }

      return await runTypescriptGrep({ ...request, rootPath })
    },
    glob: async (input): Promise<GlobSearchResult> => {
      const request = normalizeGlobRequest(input)
      const rootPath = resolve(request.cwd, request.path)

      if (bfsPath) {
        try {
          return await runBfsSearch({ executable: bfsPath, request, rootPath, runCommand })
        } catch (error) {
          if (error instanceof SearchBackendError && error.code === 'backend-unavailable') {
            // Fall through to TypeScript
          } else {
            throw error
          }
        }
      }

      return await runTypescriptGlob({ ...request, rootPath })
    }
  }
}

// ── Request normalization ────────────────────────────────────────────────────

function normalizeGrepRequest(input: GrepSearchRequest): Required<
  Omit<GrepSearchRequest, 'signal'>
> & {
  signal?: AbortSignal
} {
  const pattern = input.pattern.trim()
  if (!pattern) {
    throw new SearchBackendError('bad-input', 'pattern must not be empty.')
  }

  return {
    cwd: input.cwd,
    pattern,
    path: input.path && input.path.trim().length > 0 ? input.path : '.',
    limit: clampLimit(input.limit),
    literal: input.literal ?? false,
    caseSensitive: input.caseSensitive ?? true,
    include: input.include?.trim() || '',
    context: Math.max(0, Math.min(5, Math.trunc(input.context ?? 0))),
    signal: input.signal
  }
}

function normalizeGlobRequest(input: GlobSearchRequest): Required<
  Omit<GlobSearchRequest, 'signal'>
> & {
  signal?: AbortSignal
} {
  const pattern = input.pattern.trim()
  if (!pattern) {
    throw new SearchBackendError('bad-input', 'pattern must not be empty.')
  }

  return {
    cwd: input.cwd,
    pattern,
    path: input.path && input.path.trim().length > 0 ? input.path : '.',
    limit: clampLimit(input.limit),
    signal: input.signal
  }
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_RESULT_LIMIT
  }

  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.trunc(limit as number)))
}

// ── Ripgrep backend ──────────────────────────────────────────────────────────

async function runRipgrepSearch(input: {
  executable: string
  request: ReturnType<typeof normalizeGrepRequest>
  rootPath: string
  runCommand: (input: SearchCommandInput) => Promise<SearchCommandResult>
}): Promise<GrepSearchResult> {
  const args = [
    '--json',
    '--hidden',
    '--color',
    'never',
    '--line-number',
    '--max-count',
    String(input.request.limit),
    ...(input.request.literal ? ['--fixed-strings'] : []),
    ...(input.request.caseSensitive ? [] : ['--ignore-case']),
    ...(input.request.include ? ['--glob', input.request.include] : []),
    ...(input.request.context > 0 ? ['--context', String(input.request.context)] : []),
    input.request.pattern,
    input.rootPath
  ]
  const result = await runCliSearchCommand({
    command: input.executable,
    args,
    cwd: input.request.cwd,
    signal: input.request.signal,
    runCommand: input.runCommand
  })

  if (!result.terminatedEarly && result.exitCode !== 0 && result.exitCode !== 1) {
    throw classifyCliFailure(result.stderr)
  }

  const matches: GrepSearchMatch[] = []
  // When --context is used, rg emits "context" events around matches.
  // We accumulate them and assign: buffer → contextBefore on the next match,
  // or contextAfter on the previous match at file/stream boundaries.
  let contextBuffer: string[] = []

  for (const line of splitLines(result.stdout)) {
    if (!line) {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    if (!parsed || typeof parsed !== 'object') {
      continue
    }

    const eventType = (parsed as { type?: unknown }).type

    if (eventType === 'context') {
      const data = (parsed as { data?: Record<string, unknown> }).data
      const text = toOptionalNestedString(data, ['lines', 'text'])?.replace(/\r?\n$/, '')
      if (text !== undefined) {
        contextBuffer.push(text)
      }
      continue
    }

    if (eventType === 'begin' || eventType === 'end' || eventType === 'summary') {
      // File boundary — flush buffer as contextAfter on the previous match.
      if (contextBuffer.length > 0 && matches.length > 0) {
        const prev = matches[matches.length - 1]!
        prev.contextAfter = (prev.contextAfter ?? []).concat(contextBuffer)
      }
      contextBuffer = []
      continue
    }

    if (eventType !== 'match') {
      continue
    }

    const data = (parsed as { data?: Record<string, unknown> }).data
    const path = toOptionalNestedString(data, ['path', 'text'])
    const lineNumber = data?.['line_number']
    const text = toOptionalNestedString(data, ['lines', 'text'])?.replace(/\r?\n$/, '')

    if (!path || typeof lineNumber !== 'number' || !text) {
      continue
    }

    const match: GrepSearchMatch = {
      path: normalizeResultPath(path, input.rootPath),
      line: lineNumber,
      text,
      ...(contextBuffer.length > 0 ? { contextBefore: contextBuffer } : {})
    }
    matches.push(match)
    contextBuffer = []
  }

  // Flush trailing context to the last match
  if (contextBuffer.length > 0 && matches.length > 0) {
    const prev = matches[matches.length - 1]!
    prev.contextAfter = (prev.contextAfter ?? []).concat(contextBuffer)
  }

  return {
    backend: 'rg',
    rootPath: input.rootPath,
    matches: matches.slice(0, input.request.limit),
    truncated: matches.length > input.request.limit || Boolean(result.terminatedEarly)
  }
}

// ── bfs backend ──────────────────────────────────────────────────────────────

async function runBfsSearch(input: {
  executable: string
  request: ReturnType<typeof normalizeGlobRequest>
  rootPath: string
  runCommand: (input: SearchCommandInput) => Promise<SearchCommandResult>
}): Promise<GlobSearchResult> {
  const targetStat = await stat(input.rootPath).catch(() => null)

  if (targetStat?.isFile()) {
    const matcher = createGlobMatcher(input.request.pattern)
    const fileName = normalizeRelativePath(basename(input.rootPath))
    return {
      backend: 'bfs',
      rootPath: input.rootPath,
      paths: matcher(fileName) ? [fileName] : [],
      truncated: false
    }
  }

  // bfs uses find-compatible syntax. -name for basename matching, -path for full path.
  // For glob patterns with directory separators (like src/**/*.ts), use -path.
  const patternHasSlash = input.request.pattern.includes('/')
  const args = [
    input.rootPath,
    '-type',
    'f',
    ...(patternHasSlash
      ? ['-path', `*/${input.request.pattern}`]
      : ['-name', input.request.pattern]),
    '-print'
  ]
  const result = await runCliSearchCommand({
    command: input.executable,
    args,
    cwd: input.request.cwd,
    maxLines: input.request.limit,
    signal: input.request.signal,
    runCommand: input.runCommand
  })

  if (!result.terminatedEarly && result.exitCode !== 0) {
    throw classifyCliFailure(result.stderr)
  }

  // bfs uses find-compatible glob matching, but for complex patterns like
  // **/*.ts we may need to post-filter with our own glob matcher for accuracy.
  const matcher = createGlobMatcher(input.request.pattern)
  const paths = splitLines(result.stdout)
    .map((value) => normalizeResultPath(value, input.rootPath))
    .filter((value) => value.length > 0 && matcher(value))

  return {
    backend: 'bfs',
    rootPath: input.rootPath,
    paths: paths.slice(0, input.request.limit),
    truncated: paths.length > input.request.limit || Boolean(result.terminatedEarly)
  }
}

// ── TypeScript fallback: grep ────────────────────────────────────────────────

async function runTypescriptGrep(input: {
  cwd: string
  pattern: string
  path: string
  rootPath: string
  limit: number
  literal: boolean
  caseSensitive: boolean
  include: string
  context: number
  signal?: AbortSignal
}): Promise<GrepSearchResult> {
  const targetStat = await stat(input.rootPath).catch(() => null)
  if (!targetStat) {
    throw new SearchBackendError('bad-input', `Search path does not exist: ${input.rootPath}`)
  }

  const matcher = createLineMatcher(input.pattern, {
    literal: input.literal,
    caseSensitive: input.caseSensitive
  })
  const includeMatcher = input.include ? createGlobMatcher(input.include) : undefined
  const allFiles = targetStat.isDirectory()
    ? await collectFiles(input.rootPath, undefined, input.signal)
    : [input.rootPath]
  const files = includeMatcher ? allFiles.filter((f) => includeMatcher(basename(f))) : allFiles
  const matches: GrepSearchMatch[] = []

  for (const filePath of files) {
    throwIfAborted(input.signal)
    const contents = await readFile(filePath, 'utf8').catch(() => null)
    if (contents === null) {
      continue
    }

    const lines = contents.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      if (!matcher(lines[index] ?? '')) {
        continue
      }

      const match: GrepSearchMatch = {
        path: normalizeResultPath(filePath, input.rootPath),
        line: index + 1,
        text: lines[index] ?? ''
      }

      if (input.context > 0) {
        const beforeStart = Math.max(0, index - input.context)
        match.contextBefore = lines.slice(beforeStart, index)
        const afterEnd = Math.min(lines.length, index + 1 + input.context)
        match.contextAfter = lines.slice(index + 1, afterEnd)
      }

      matches.push(match)

      if (matches.length >= input.limit) {
        return {
          backend: 'typescript',
          rootPath: input.rootPath,
          matches,
          truncated: true
        }
      }
    }
  }

  return {
    backend: 'typescript',
    rootPath: input.rootPath,
    matches,
    truncated: false
  }
}

// ── TypeScript fallback: glob ────────────────────────────────────────────────

async function runTypescriptGlob(input: {
  cwd: string
  pattern: string
  path: string
  rootPath: string
  limit: number
  signal?: AbortSignal
}): Promise<GlobSearchResult> {
  const targetStat = await stat(input.rootPath).catch(() => null)
  if (!targetStat) {
    throw new SearchBackendError('bad-input', `Search path does not exist: ${input.rootPath}`)
  }

  const matcher = createGlobMatcher(input.pattern)
  const results: string[] = []

  if (targetStat.isFile()) {
    const relativePath = normalizeRelativePath(basename(input.rootPath))
    if (matcher(relativePath)) {
      results.push(relativePath)
    }
  } else {
    const files = await collectFiles(input.rootPath, undefined, input.signal)
    for (const filePath of files) {
      const relativePath = normalizeRelativePath(relative(input.rootPath, filePath))
      if (matcher(relativePath)) {
        results.push(relativePath)
      }

      if (results.length >= input.limit) {
        return {
          backend: 'typescript',
          rootPath: input.rootPath,
          paths: results,
          truncated: true
        }
      }
    }
  }

  return {
    backend: 'typescript',
    rootPath: input.rootPath,
    paths: results,
    truncated: false
  }
}

// ── Shared utilities ─────────────────────────────────────────────────────────

function createLineMatcher(
  pattern: string,
  options: {
    literal: boolean
    caseSensitive: boolean
  }
): (value: string) => boolean {
  if (options.literal) {
    const needle = options.caseSensitive ? pattern : pattern.toLowerCase()
    return (value): boolean =>
      (options.caseSensitive ? value : value.toLowerCase()).includes(needle)
  }

  let regex: RegExp
  try {
    regex = new RegExp(pattern, options.caseSensitive ? 'm' : 'im')
  } catch (error) {
    throw new SearchBackendError(
      'bad-input',
      error instanceof Error ? error.message : 'Invalid regular expression.'
    )
  }

  return (value): boolean => regex.test(value)
}

async function collectFiles(
  currentPath: string,
  limit: number | undefined,
  signal?: AbortSignal,
  results: string[] = []
): Promise<string[]> {
  if (limit !== undefined && results.length >= limit) {
    return results
  }

  throwIfAborted(signal)
  const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    const entryPath = join(currentPath, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(entryPath, limit, signal, results)
    } else if (entry.isFile()) {
      results.push(entryPath)
    }

    if (limit !== undefined && results.length >= limit) {
      return results
    }
  }

  return results
}

function createGlobMatcher(pattern: string): (value: string) => boolean {
  const regex = globPatternToRegExp(pattern)
  return (value): boolean => regex.test(value)
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeRelativePath(pattern.replace(/^\.\//, ''))
  let source = '^'

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index]
    const next = normalizedPattern[index + 1]

    if (char === '*' && next === '*') {
      const nextNext = normalizedPattern[index + 2]
      source += nextNext === '/' ? '(?:.*/)?' : '.*'
      index += nextNext === '/' ? 2 : 1
      continue
    }

    if (char === '*') {
      source += '[^/]*'
      continue
    }

    if (char === '?') {
      source += '[^/]'
      continue
    }

    source += escapeRegExp(char)
  }

  source += '$'
  return new RegExp(source)
}

function normalizeResultPath(value: string, rootPath: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  const cleaned = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed
  const absolutePath = isAbsolute(cleaned) ? cleaned : resolve(rootPath, cleaned)
  const relativePath = relative(rootPath, absolutePath)

  if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    return normalizeRelativePath(relativePath)
  }

  return normalizeRelativePath(cleaned)
}

function normalizeRelativePath(value: string): string {
  return normalize(value).split(sep).join('/')
}

function classifyCliFailure(stderr: string): SearchBackendError {
  const normalized = stderr.trim()
  if (/regex|regular expression|invalid pattern/i.test(normalized)) {
    return new SearchBackendError('bad-input', normalized || 'Invalid search pattern.')
  }

  return new SearchBackendError(
    'execution-failed',
    normalized || 'Search command failed unexpectedly.'
  )
}

async function runCliSearchCommand(input: {
  command: string
  args: string[]
  cwd: string
  maxLines?: number
  signal?: AbortSignal
  runCommand: (input: SearchCommandInput) => Promise<SearchCommandResult>
}): Promise<SearchCommandResult> {
  try {
    return await input.runCommand({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      maxLines: input.maxLines,
      signal: input.signal
    })
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as { code?: unknown }).code === 'ENOENT' ||
        (error as { code?: unknown }).code === 'ENOTDIR')
    ) {
      throw new SearchBackendError(
        'backend-unavailable',
        `Search backend unavailable: ${input.command}`
      )
    }

    throw error
  }
}

async function runSearchCommand(input: SearchCommandInput): Promise<SearchCommandResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let stdoutLineCount = 0
    let terminatedEarly = false

    const onAbort = (): void => {
      child.kill('SIGTERM')
    }

    const finishEarly = (): void => {
      if (terminatedEarly) {
        return
      }

      terminatedEarly = true
      child.kill('SIGTERM')
    }

    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (terminatedEarly) {
        return
      }

      if (stdout.length < MAX_SEARCH_STDOUT_CHARS) {
        const remaining = MAX_SEARCH_STDOUT_CHARS - stdout.length
        stdout += chunk.slice(0, remaining)
      }

      stdoutLineCount += countNewlines(chunk)
      if (
        stdout.length >= MAX_SEARCH_STDOUT_CHARS ||
        (input.maxLines !== undefined && stdoutLineCount >= input.maxLines)
      ) {
        finishEarly()
      }
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length >= MAX_SEARCH_STDERR_CHARS) {
        return
      }

      const remaining = MAX_SEARCH_STDERR_CHARS - stderr.length
      stderr += chunk.slice(0, remaining)
    })
    child.once('error', (error) => {
      input.signal?.removeEventListener('abort', onAbort)
      rejectPromise(error)
    })
    child.once('close', (exitCode) => {
      input.signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        exitCode: exitCode ?? 0,
        stdout,
        stderr,
        ...(terminatedEarly ? { terminatedEarly: true } : {})
      })
    })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }

  const error = new Error('Aborted')
  error.name = 'AbortError'
  throw error
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0)
}

function countNewlines(value: string): number {
  return value.length === 0 ? 0 : (value.match(/\n/g) ?? []).length
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function toOptionalNestedString(
  value: Record<string, unknown> | undefined,
  path: string[]
): string | undefined {
  let current: unknown = value

  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return typeof current === 'string' ? current : undefined
}
