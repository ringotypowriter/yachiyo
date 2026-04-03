import { accessSync, constants } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter } from 'node:path'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'

export type GrepBackendKind = 'rg' | 'grep' | 'typescript'
export type FileDiscoveryBackendKind = 'fd' | 'find' | 'typescript'
export type SearchBackendKind = GrepBackendKind | FileDiscoveryBackendKind

interface ResolvedCliBackend {
  executable: string
}

export interface SearchBackendCapabilities {
  grep: {
    preferred: GrepBackendKind
    backends: Partial<Record<'rg' | 'grep', ResolvedCliBackend>>
  }
  fileDiscovery: {
    preferred: FileDiscoveryBackendKind
    backends: Partial<Record<'fd' | 'find', ResolvedCliBackend>>
  }
}

export interface ResolveSearchBackendCapabilitiesOptions {
  env?: NodeJS.ProcessEnv
  resolveCommand?: (command: string, env?: NodeJS.ProcessEnv) => string | undefined
  /**
   * Extra PATH segments to probe after the environment PATH. Defaults to
   * well-known package-manager directories that GUI apps miss on macOS because
   * launchd provides a minimal PATH that excludes Homebrew and cargo.
   */
  extraPaths?: string[]
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
  capabilities?: SearchBackendCapabilities
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
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com']

// GUI apps on macOS receive a minimal PATH from launchd that omits user-level
// package manager directories. These are the most common install locations for fd/rg.
export const DEFAULT_EXTRA_PATHS: readonly string[] =
  process.platform === 'darwin'
    ? [
        '/opt/homebrew/bin', // Apple Silicon Homebrew
        '/usr/local/bin', // Intel Homebrew
        `${homedir()}/.cargo/bin` // Rust tools (rg)
      ]
    : []

export function resolveSearchBackendCapabilities(
  options: ResolveSearchBackendCapabilitiesOptions = {}
): SearchBackendCapabilities {
  const resolveCommandFromPath = options.resolveCommand ?? findExecutableOnPath
  const baseEnv = options.env ?? process.env
  const extraPaths = options.extraPaths ?? DEFAULT_EXTRA_PATHS
  const env = augmentPathEnv(baseEnv, extraPaths)
  const rgExecutable = resolveCommandFromPath('rg', env)
  const grepExecutable = resolveCommandFromPath('grep', env)
  const fdExecutable = resolveCommandFromPath('fd', env)
  const findExecutable = resolveCommandFromPath('find', env)

  return {
    grep: {
      preferred: rgExecutable ? 'rg' : grepExecutable ? 'grep' : 'typescript',
      backends: {
        ...(rgExecutable ? { rg: { executable: rgExecutable } } : {}),
        ...(grepExecutable ? { grep: { executable: grepExecutable } } : {})
      }
    },
    fileDiscovery: {
      preferred: fdExecutable ? 'fd' : findExecutable ? 'find' : 'typescript',
      backends: {
        ...(fdExecutable ? { fd: { executable: fdExecutable } } : {}),
        ...(findExecutable ? { find: { executable: findExecutable } } : {})
      }
    }
  }
}

export function createSearchService(options: CreateSearchServiceOptions = {}): SearchService {
  const capabilities = options.capabilities ?? resolveSearchBackendCapabilities()
  const runCommand = options.runCommand ?? runSearchCommand

  return {
    capabilities,
    grep: async (input): Promise<GrepSearchResult> => {
      const request = normalizeGrepRequest(input)
      const rootPath = resolve(request.cwd, request.path)
      const backendOrder = resolveGrepBackendOrder(capabilities)
      let lastUnavailableError: SearchBackendError | undefined

      for (const backend of backendOrder) {
        try {
          if (backend === 'typescript') {
            return await runTypescriptGrep({
              ...request,
              rootPath
            })
          }

          if (backend === 'rg') {
            const executable = capabilities.grep.backends.rg?.executable
            if (!executable) {
              continue
            }

            return await runRipgrepSearch({
              executable,
              request,
              rootPath,
              runCommand
            })
          }

          const executable = capabilities.grep.backends.grep?.executable
          if (!executable) {
            continue
          }

          return await runGrepSearch({
            executable,
            request,
            rootPath,
            runCommand
          })
        } catch (error) {
          if (error instanceof SearchBackendError && error.code === 'backend-unavailable') {
            lastUnavailableError = error
            continue
          }

          throw error
        }
      }

      if (lastUnavailableError) {
        throw lastUnavailableError
      }

      return await runTypescriptGrep({
        ...request,
        rootPath
      })
    },
    glob: async (input): Promise<GlobSearchResult> => {
      const request = normalizeGlobRequest(input)
      const rootPath = resolve(request.cwd, request.path)
      const backendOrder = resolveFileDiscoveryBackendOrder(capabilities)
      let lastUnavailableError: SearchBackendError | undefined

      for (const backend of backendOrder) {
        try {
          if (backend === 'typescript') {
            return await runTypescriptGlob({
              ...request,
              rootPath
            })
          }

          if (backend === 'fd') {
            const executable = capabilities.fileDiscovery.backends.fd?.executable
            if (!executable) {
              continue
            }

            return await runFdSearch({
              executable,
              request,
              rootPath,
              runCommand
            })
          }

          const executable = capabilities.fileDiscovery.backends.find?.executable
          if (!executable) {
            continue
          }

          return await runFindSearch({
            executable,
            request,
            rootPath,
            runCommand
          })
        } catch (error) {
          if (error instanceof SearchBackendError && error.code === 'backend-unavailable') {
            lastUnavailableError = error
            continue
          }

          throw error
        }
      }

      if (lastUnavailableError) {
        throw lastUnavailableError
      }

      return await runTypescriptGlob({
        ...request,
        rootPath
      })
    }
  }
}

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

function resolveGrepBackendOrder(capabilities: SearchBackendCapabilities): GrepBackendKind[] {
  const order: GrepBackendKind[] = [capabilities.grep.preferred]

  for (const backend of ['rg', 'grep', 'typescript'] as const) {
    if (!order.includes(backend)) {
      order.push(backend)
    }
  }

  return order
}

function resolveFileDiscoveryBackendOrder(
  capabilities: SearchBackendCapabilities
): FileDiscoveryBackendKind[] {
  const order: FileDiscoveryBackendKind[] = [capabilities.fileDiscovery.preferred]

  for (const backend of ['fd', 'find', 'typescript'] as const) {
    if (!order.includes(backend)) {
      order.push(backend)
    }
  }

  return order
}

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

async function runGrepSearch(input: {
  executable: string
  request: ReturnType<typeof normalizeGrepRequest>
  rootPath: string
  runCommand: (input: SearchCommandInput) => Promise<SearchCommandResult>
}): Promise<GrepSearchResult> {
  const targetStat = await stat(input.rootPath).catch(() => null)
  if (!targetStat) {
    throw new SearchBackendError('bad-input', `Search path does not exist: ${input.rootPath}`)
  }

  const args = [
    ...(targetStat.isDirectory() ? ['-R'] : []),
    '-n',
    '-H',
    ...(input.request.literal ? ['-F'] : ['-E']),
    ...(input.request.caseSensitive ? [] : ['-i']),
    ...(input.request.include ? ['--include', input.request.include] : []),
    ...(input.request.context > 0 ? ['-C', String(input.request.context)] : []),
    '-m',
    String(input.request.limit),
    '-e',
    input.request.pattern,
    input.rootPath
  ]
  const result = await runCliSearchCommand({
    command: input.executable,
    args,
    cwd: input.request.cwd,
    maxLines: input.request.limit,
    signal: input.request.signal,
    runCommand: input.runCommand
  })

  if (!result.terminatedEarly && result.exitCode !== 0 && result.exitCode !== 1) {
    throw classifyCliFailure(result.stderr)
  }

  const matches: GrepSearchMatch[] = []

  for (const line of splitLines(result.stdout)) {
    const parsed = parseColonSeparatedGrepLine(line)
    if (!parsed) {
      continue
    }

    matches.push({
      path: normalizeResultPath(parsed.path, input.rootPath),
      line: parsed.line,
      text: parsed.text
    })
  }

  return {
    backend: 'grep',
    rootPath: input.rootPath,
    matches: matches.slice(0, input.request.limit),
    truncated: matches.length > input.request.limit || Boolean(result.terminatedEarly)
  }
}

async function runFdSearch(input: {
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
      backend: 'fd',
      rootPath: input.rootPath,
      paths: matcher(fileName) ? [fileName] : [],
      truncated: false
    }
  }

  const args = [
    '--glob',
    '--hidden',
    '--color',
    'never',
    '--max-results',
    String(input.request.limit),
    input.request.pattern,
    input.rootPath
  ]
  const result = await runCliSearchCommand({
    command: input.executable,
    args,
    cwd: input.request.cwd,
    maxLines: input.request.limit,
    signal: input.request.signal,
    runCommand: input.runCommand
  })

  if (!result.terminatedEarly && result.exitCode !== 0 && result.exitCode !== 1) {
    throw classifyCliFailure(result.stderr)
  }

  const paths = splitLines(result.stdout)
    .map((value) => normalizeResultPath(value, input.rootPath))
    .filter(Boolean)

  return {
    backend: 'fd',
    rootPath: input.rootPath,
    paths: paths.slice(0, input.request.limit),
    truncated: paths.length > input.request.limit || Boolean(result.terminatedEarly)
  }
}

async function runFindSearch(input: {
  executable: string
  request: ReturnType<typeof normalizeGlobRequest>
  rootPath: string
  runCommand: (input: SearchCommandInput) => Promise<SearchCommandResult>
}): Promise<GlobSearchResult> {
  const targetStat = await stat(input.rootPath).catch(() => null)
  const matcher = createGlobMatcher(input.request.pattern)

  if (targetStat?.isFile()) {
    const fileName = normalizeRelativePath(basename(input.rootPath))
    return {
      backend: 'find',
      rootPath: input.rootPath,
      paths: matcher(fileName) ? [fileName] : [],
      truncated: false
    }
  }

  const args = [input.rootPath, '-type', 'f', '-print']
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

  const paths = splitLines(result.stdout)
    .map((value) => normalizeResultPath(value, input.rootPath))
    .filter((value) => matcher(value))
    .filter(Boolean)

  return {
    backend: 'find',
    rootPath: input.rootPath,
    paths: paths.slice(0, input.request.limit),
    truncated: paths.length > input.request.limit || Boolean(result.terminatedEarly)
  }
}

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

function parseColonSeparatedGrepLine(
  value: string
): { path: string; line: number; text: string } | undefined {
  const match = /^(.*?):(\d+):(.*)$/.exec(value)
  if (!match) {
    return undefined
  }

  return {
    path: match[1] ?? '',
    line: Number(match[2]),
    text: match[3] ?? ''
  }
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
      (error as { code?: unknown }).code === 'ENOENT'
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

function augmentPathEnv(env: NodeJS.ProcessEnv, extraPaths: readonly string[]): NodeJS.ProcessEnv {
  if (extraPaths.length === 0) {
    return env
  }

  const existing = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const novel = extraPaths.filter((p) => !existing.includes(p))

  if (novel.length === 0) {
    return env
  }

  return { ...env, PATH: [...existing, ...novel].join(delimiter) }
}

function findExecutableOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const pathValue = env.PATH
  if (!pathValue) {
    return undefined
  }

  const candidateNames =
    process.platform === 'win32'
      ? [command, ...WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${command}${extension}`)]
      : [command]

  for (const segment of pathValue.split(delimiter)) {
    if (!segment) {
      continue
    }

    for (const candidateName of candidateNames) {
      const candidatePath = join(segment, candidateName)
      if (isExecutable(candidatePath)) {
        return candidatePath
      }
    }
  }

  return undefined
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
