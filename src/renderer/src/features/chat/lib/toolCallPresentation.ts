import type {
  AskUserToolCallDetails,
  BashToolCallDetails,
  EditToolCallDetails,
  GlobToolCallDetails,
  GrepToolCallDetails,
  JsReplToolCallDetails,
  ReadToolCallDetails,
  ToolCall,
  WebReadToolCallDetails,
  WebSearchResultItem,
  WebSearchToolCallDetails,
  WriteToolCallDetails
} from '../../../app/types.ts'

type ToolCallDetailTone = 'danger'

/**
 * Presentation tier for tool call detail blocks:
 * - 'secondary': shown in the expandable section inline in chat
 * - 'inspection': only shown in the dedicated run inspection panel
 *
 * Absence of displayTier is treated as 'secondary'.
 */
export type ToolCallDetailDisplayTier = 'secondary' | 'inspection'

export interface ToolCallDetailField {
  label: string
  value: string
  tone?: ToolCallDetailTone
}

export interface ToolCallDetailCodeBlock {
  label: string
  value: string
  tone?: ToolCallDetailTone
  displayTier?: ToolCallDetailDisplayTier
}

export interface ToolCallDetailsPresentation {
  fields: ToolCallDetailField[]
  codeBlocks: ToolCallDetailCodeBlock[]
  searchResults?: WebSearchResultItem[]
}

const OUTPUT_TAIL_MAX_LINES = 12
const OUTPUT_TAIL_MAX_CHARS = 1200

function pushField(
  fields: ToolCallDetailField[],
  label: string,
  value: string | number | undefined,
  tone?: ToolCallDetailTone
): void {
  if (value === undefined) {
    return
  }

  fields.push({
    label,
    value: String(value),
    ...(tone ? { tone } : {})
  })
}

function pushCodeBlock(
  codeBlocks: ToolCallDetailCodeBlock[],
  label: string,
  value: string | undefined,
  tone?: ToolCallDetailTone,
  displayTier?: ToolCallDetailDisplayTier
): void {
  const normalizedValue = value?.trimEnd()
  if (!normalizedValue) {
    return
  }

  codeBlocks.push({
    label,
    value: normalizedValue,
    ...(tone ? { tone } : {}),
    ...(displayTier ? { displayTier } : {})
  })
}

function toYesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

function takeTextTail(
  value: string,
  options: { maxLines?: number; maxChars?: number } = {}
): { text: string; truncated: boolean } {
  const trimmedValue = value.trimEnd()
  if (!trimmedValue) {
    return { text: '', truncated: false }
  }

  const maxLines = options.maxLines ?? OUTPUT_TAIL_MAX_LINES
  const maxChars = options.maxChars ?? OUTPUT_TAIL_MAX_CHARS

  const lines = trimmedValue.split(/\r?\n/)
  const lineTail = lines.slice(-maxLines)
  let text = lineTail.join('\n')
  let truncated = lineTail.length !== lines.length

  if (text.length > maxChars) {
    text = text.slice(-maxChars)
    truncated = true

    const firstNewlineIndex = text.indexOf('\n')
    if (firstNewlineIndex > 0 && firstNewlineIndex < text.length - 1) {
      text = text.slice(firstNewlineIndex + 1)
    }
  }

  return { text, truncated }
}

function takeTextHead(
  value: string,
  options: { maxLines?: number; maxChars?: number } = {}
): { text: string; truncated: boolean } {
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return { text: '', truncated: false }
  }

  const maxLines = options.maxLines ?? OUTPUT_TAIL_MAX_LINES
  const maxChars = options.maxChars ?? OUTPUT_TAIL_MAX_CHARS

  const lines = trimmedValue.split(/\r?\n/)
  const lineHead = lines.slice(0, maxLines)
  let text = lineHead.join('\n')
  let truncated = lineHead.length !== lines.length

  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd()
    truncated = true
  }

  return { text, truncated }
}

function pushOutputTail(
  codeBlocks: ToolCallDetailCodeBlock[],
  label: string,
  value: string,
  tone?: ToolCallDetailTone,
  displayTier?: ToolCallDetailDisplayTier
): void {
  const tail = takeTextTail(value)
  if (!tail.text) {
    return
  }

  pushCodeBlock(codeBlocks, tail.truncated ? `${label} tail` : label, tail.text, tone, displayTier)
}

function pushOutputHead(
  codeBlocks: ToolCallDetailCodeBlock[],
  label: string,
  value: string,
  tone?: ToolCallDetailTone,
  displayTier?: ToolCallDetailDisplayTier
): void {
  const head = takeTextHead(value)
  if (!head.text) {
    return
  }

  pushCodeBlock(
    codeBlocks,
    head.truncated ? `${label} excerpt` : label,
    head.text,
    tone,
    displayTier
  )
}

export function buildToolCallDetailsPresentation(toolCall: ToolCall): ToolCallDetailsPresentation {
  const fields: ToolCallDetailField[] = []
  const codeBlocks: ToolCallDetailCodeBlock[] = []

  pushCodeBlock(codeBlocks, 'error', toolCall.error, 'danger')

  if (toolCall.toolName === 'read') {
    const details = toolCall.details as ReadToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    if (details.mediaType === 'application/pdf') {
      pushField(fields, 'pages', details.totalPages)
      pushField(fields, 'start line', details.startLine)
      pushField(fields, 'end line', details.endLine)
      if (details.truncated) {
        pushField(fields, 'truncated', 'yes')
      }
      pushField(fields, 'next offset', details.nextOffset)
      pushField(fields, 'remaining lines', details.remainingLines)
      if (details.cached) {
        pushField(fields, 'cached', 'yes')
      }
      return { fields, codeBlocks }
    }

    pushField(fields, 'start line', details.startLine)
    pushField(fields, 'end line', details.endLine)
    if (details.truncated) {
      pushField(fields, 'truncated', 'yes')
    }
    pushField(fields, 'next offset', details.nextOffset)
    pushField(fields, 'remaining lines', details.remainingLines)
    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'edit') {
    const details = toolCall.details as EditToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'mode', details.mode)
    pushField(fields, 'replacements', details.replacements)
    pushField(fields, 'first changed line', details.firstChangedLine)
    pushCodeBlock(codeBlocks, 'diff', details.diff)
    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'write') {
    const details = toolCall.details as WriteToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'bytes written', details.bytesWritten)
    pushField(fields, 'created', toYesNo(details.created))
    pushField(fields, 'overwritten', toYesNo(details.overwritten))
    pushCodeBlock(codeBlocks, 'preview', details.contentPreview)
    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'bash') {
    const details = toolCall.details as BashToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushCodeBlock(codeBlocks, 'command', details.command)

    if (details.background) {
      pushField(fields, 'task id', details.taskId)
      pushField(fields, 'log file', details.logPath)
      // Only show exit code once the background task has completed
      if (details.exitCode !== undefined) {
        pushField(
          fields,
          'exit code',
          details.exitCode,
          details.exitCode !== 0 ? 'danger' : undefined
        )
      }
      return { fields, codeBlocks }
    }

    pushField(fields, 'exit code', details.exitCode, details.exitCode !== 0 ? 'danger' : undefined)

    if (details.timedOut) {
      pushField(fields, 'timed out', 'yes')
    }

    if (details.blocked) {
      pushField(fields, 'blocked', 'yes')
    }

    if (details.truncated) {
      pushField(fields, 'output truncated', 'yes')
    }

    pushField(fields, 'output file', details.outputFilePath)
    // stderr shown inline only when it carries error signal; otherwise defer to inspection panel
    const stderrTone = toolCall.status === 'failed' || details.blocked ? 'danger' : undefined
    pushOutputTail(
      codeBlocks,
      'stderr',
      details.stderr,
      stderrTone,
      stderrTone ? undefined : 'inspection'
    )
    // stdout shown inline so the user can see what the command produced
    pushCodeBlock(codeBlocks, 'stdout', details.stdout)
  }

  if (toolCall.toolName === 'jsRepl') {
    const details = toolCall.details as JsReplToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    if (details.cwd) {
      pushField(fields, 'cwd', details.cwd)
    }
    if (details.timedOut) {
      pushField(fields, 'timed out', 'yes')
    }
    if (details.contextReset) {
      pushField(fields, 'context reset', 'yes')
    }

    pushCodeBlock(codeBlocks, 'code', details.code)
    pushOutputTail(codeBlocks, 'console', details.consoleOutput ?? '')
    pushCodeBlock(codeBlocks, 'result', details.result)
    if (details.error) {
      pushCodeBlock(codeBlocks, 'error', details.error, 'danger')
    }

    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'grep') {
    const details = toolCall.details as GrepToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'backend', details.backend)
    pushField(fields, 'path', details.path)
    pushField(fields, 'results', details.resultCount)
    if (details.truncated) {
      pushField(fields, 'truncated', 'yes')
    }
    // Full match list can be long — inspection panel only; count already shown in fields
    pushCodeBlock(
      codeBlocks,
      'matches',
      details.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n'),
      undefined,
      'inspection'
    )

    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'glob') {
    const details = toolCall.details as GlobToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'backend', details.backend)
    pushField(fields, 'path', details.path)
    pushField(fields, 'results', details.resultCount)
    if (details.truncated) {
      pushField(fields, 'truncated', 'yes')
    }
    // Full file list deferred to inspection panel; count already shown in fields
    pushCodeBlock(codeBlocks, 'matches', details.matches.join('\n'), undefined, 'inspection')

    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'webRead') {
    const details = toolCall.details as WebReadToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'final url', details.finalUrl)
    pushField(fields, 'http status', details.httpStatus)
    pushField(fields, 'content type', details.contentType)
    pushField(fields, 'extractor', details.extractor)
    pushField(fields, 'title', details.title)
    pushField(fields, 'author', details.author)
    pushField(fields, 'site name', details.siteName)
    pushField(fields, 'published', details.publishedTime)
    pushField(fields, 'format', details.contentFormat)
    if (details.truncated) {
      pushField(fields, 'truncated', 'yes')
    }
    pushField(fields, 'original chars', details.originalContentChars)
    pushField(fields, 'saved file', details.savedFilePath)
    pushField(fields, 'saved bytes', details.savedBytes)
    pushField(fields, 'failure code', details.failureCode)
    pushCodeBlock(codeBlocks, 'description', details.description)
    // Full web content belongs in the inspection panel, not inline in chat
    pushOutputHead(codeBlocks, 'content', details.content, undefined, 'inspection')

    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'askUser') {
    const details = toolCall.details as AskUserToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'question', details.question)
    pushField(fields, 'answer', details.answer)
    return { fields, codeBlocks }
  }

  if (toolCall.toolName === 'webSearch') {
    const details = toolCall.details as WebSearchToolCallDetails | undefined
    if (!details) {
      return { fields, codeBlocks }
    }

    pushField(fields, 'provider', details.provider)
    pushField(fields, 'query', details.query)
    pushField(fields, 'failure code', details.failureCode)

    return { fields, codeBlocks, searchResults: details.results }
  }

  return { fields, codeBlocks }
}

/**
 * Compress a file path for compact display in tool call summaries.
 *
 * Rules:
 * - Paths <= 45 chars are returned as-is.
 * - For longer paths: keep the first 2 meaningful segments and the last segment
 *   intact; abbreviate every middle segment longer than 4 chars to its first letter.
 *
 * Examples:
 *   /a/b/c/d.txt               → /a/b/c/d.txt          (short enough)
 *   /a/verylong/path/to/f.txt  → /a/verylong/p/t/f.txt (middle compressed)
 */
export function compressPath(path: string, maxLen: number = 45): string {
  if (path.length <= maxLen) return path

  const segments = path.split('/')
  if (segments.length <= 3) return path

  const result: string[] = []
  const start = segments[0] === '' ? 1 : 0

  if (start === 1) result.push('')

  // Keep first 2 meaningful segments
  const keepHead = Math.min(start + 2, segments.length - 1)
  for (let i = start; i < keepHead; i++) {
    result.push(segments[i])
  }

  // Compress middle segments: if length > 4, keep only the first letter
  const shortenThreshold = 5
  for (let i = keepHead; i < segments.length - 1; i++) {
    if (segments[i].length > shortenThreshold) {
      result.push(segments[i][0])
    } else {
      result.push(segments[i])
    }
  }

  // Keep last segment intact
  result.push(segments[segments.length - 1])

  return result.join('/')
}

export function stripWorkspacePath(path: string, workspacePath?: string | null): string {
  const normalizedWorkspace = workspacePath?.trim().replace(/\/+$/, '')
  if (!path.startsWith('/') || !normalizedWorkspace) {
    return path
  }

  if (path === normalizedWorkspace) {
    return '.'
  }

  const workspacePrefix = `${normalizedWorkspace}/`
  return path.startsWith(workspacePrefix) ? path.slice(workspacePrefix.length) : path
}

export function formatToolFilePath(path: string, workspacePath?: string | null): string {
  return compressPath(stripWorkspacePath(path, workspacePath))
}

function splitPathDirectory(path: string): { directory: string; basename: string } {
  const slashIndex = path.lastIndexOf('/')
  if (slashIndex === -1) {
    return { directory: '', basename: path }
  }

  return {
    directory: path.slice(0, slashIndex),
    basename: path.slice(slashIndex + 1)
  }
}

function getSharedPathPrefix(paths: string[]): string {
  const firstSegments = paths[0]?.split('/') ?? []
  let sharedLength = firstSegments.length

  for (const path of paths.slice(1)) {
    const segments = path.split('/')
    sharedLength = Math.min(sharedLength, segments.length)

    for (let index = 0; index < sharedLength; index++) {
      if (segments[index] !== firstSegments[index]) {
        sharedLength = index
        break
      }
    }
  }

  return firstSegments.slice(0, sharedLength).join('/')
}

export function formatToolFilePathList(paths: string[], workspacePath?: string | null): string[] {
  const strippedPaths = paths.map((path) => stripWorkspacePath(path, workspacePath))
  if (strippedPaths.length <= 1) {
    return strippedPaths.map((path) => compressPath(path))
  }

  const pathParts = strippedPaths.map(splitPathDirectory)
  if (pathParts.some((part) => !part.directory)) {
    return strippedPaths.map((path) => compressPath(path))
  }

  const sharedPrefix = getSharedPathPrefix(pathParts.map((part) => part.directory))
  if (sharedPrefix) {
    return strippedPaths.map((path, index) =>
      index === 0 ? compressPath(path) : compressPath(path.slice(sharedPrefix.length + 1))
    )
  }

  return strippedPaths.map((path) => compressPath(path))
}
