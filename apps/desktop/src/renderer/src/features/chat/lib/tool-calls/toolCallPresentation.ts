import type {
  ApplyPatchToolCallDetails,
  AskUserToolCallDetails,
  BashToolCallDetails,
  EditToolCallDetails,
  GlobToolCallDetails,
  GrepToolCallDetails,
  JsReplToolCallDetails,
  ReadToolCallDetails,
  ToolCall,
  WebReadToolCallDetails,
  WebSearchToolCallDetails,
  WriteToolCallDetails
} from '@renderer/app/types'

type ToolCallDetailTone = 'danger'

export interface ToolCallDetailCodeBlock {
  label: string
  value: string
  filePath?: string
  tone?: ToolCallDetailTone
}

export interface ToolCallDetailsPresentation {
  input?: ToolCallDetailCodeBlock
  metadata?: ToolCallDetailCodeBlock
  output?: ToolCallDetailCodeBlock
}

export interface ToolCallRowSummary {
  inputSummary?: string
  outputSummary?: string
}

function buildFixedBashRowStatus(toolCall: ToolCall): string {
  if (toolCall.status === 'preparing') return 'preparing'
  if (toolCall.status === 'running') return 'running'
  if (toolCall.status === 'failed') return 'failed'
  if (toolCall.status === 'waiting-for-user') return 'waiting'
  if (toolCall.status === 'background') return 'background'
  return 'completed'
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function renderRawValue(value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'content' &&
    'value' in value &&
    Array.isArray(value.value)
  ) {
    const text = value.value
      .map((block) =>
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
          ? block.text
          : stringifyJson(block)
      )
      .join('')
      .trimEnd()
    return text || stringifyJson(value.value)
  }

  return typeof value === 'string' ? value.trimEnd() : stringifyJson(value)
}

function compactJson(value: Record<string, unknown>): string {
  return stringifyJson(
    Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== '')
    )
  )
}

function compactJsonBlock(value: Record<string, unknown>): string | undefined {
  const compact = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== '')
  )
  return Object.keys(compact).length > 0 ? stringifyJson(compact) : undefined
}

function metadataBlock(value: Record<string, unknown>): ToolCallDetailCodeBlock | undefined {
  const rendered = compactJsonBlock(value)
  return rendered ? { label: 'Metadata', value: rendered } : undefined
}

function buildFallbackInput(toolCall: ToolCall): string | undefined {
  if (toolCall.details) {
    if (toolCall.toolName === 'bash') {
      return (toolCall.details as BashToolCallDetails).command
    }
    if (toolCall.toolName === 'jsRepl') {
      return (toolCall.details as JsReplToolCallDetails).code
    }
    if (toolCall.toolName === 'read') {
      const details = toolCall.details as ReadToolCallDetails
      return compactJson({ path: details.path, offset: details.startLine })
    }
    if (toolCall.toolName === 'write') {
      return compactJson({ path: (toolCall.details as WriteToolCallDetails).path })
    }
    if (toolCall.toolName === 'edit') {
      const details = toolCall.details as EditToolCallDetails
      return compactJson({ path: details.path, mode: details.mode })
    }
    if (toolCall.toolName === 'grep') {
      const details = toolCall.details as GrepToolCallDetails
      return compactJson({
        pattern: details.pattern,
        path: details.path
      })
    }
    if (toolCall.toolName === 'glob') {
      const details = toolCall.details as GlobToolCallDetails
      return compactJson({
        pattern: details.pattern,
        path: details.path
      })
    }
    if (toolCall.toolName === 'webRead') {
      const details = toolCall.details as WebReadToolCallDetails
      return compactJson({ url: details.requestedUrl, format: details.contentFormat })
    }
    if (toolCall.toolName === 'webSearch') {
      return compactJson({ query: (toolCall.details as WebSearchToolCallDetails).query })
    }
    if (toolCall.toolName === 'askUser') {
      const details = toolCall.details as AskUserToolCallDetails
      return compactJson({ question: details.question, choices: details.choices })
    }
    if (toolCall.toolName === 'applyPatch') {
      const details = toolCall.details as ApplyPatchToolCallDetails
      return details.operations
        .map((op) =>
          op.operation === 'move'
            ? `move ${op.path} -> ${op.movePath ?? ''}`
            : `${op.operation} ${op.path}`
        )
        .join('\n')
    }
  }

  return toolCall.inputSummary || undefined
}

function buildFallbackMetadata(toolCall: ToolCall): ToolCallDetailCodeBlock | undefined {
  if (!toolCall.details) return undefined

  if (toolCall.toolName === 'bash') {
    const details = toolCall.details as BashToolCallDetails
    return metadataBlock({
      cwd: details.cwd,
      exitCode: details.exitCode,
      timedOut: details.timedOut,
      blocked: details.blocked,
      truncated: details.truncated,
      outputFile: details.outputFilePath,
      background: details.background,
      taskId: details.taskId,
      logPath: details.logPath,
      liftedAfterTimeout: details.liftedAfterTimeout
    })
  }

  if (toolCall.toolName === 'grep') {
    const details = toolCall.details as GrepToolCallDetails
    return metadataBlock({
      backend: details.backend,
      resultCount: details.resultCount,
      truncated: details.truncated
    })
  }

  if (toolCall.toolName === 'glob') {
    const details = toolCall.details as GlobToolCallDetails
    return metadataBlock({
      backend: details.backend,
      resultCount: details.resultCount,
      truncated: details.truncated
    })
  }

  return undefined
}

function buildApplyPatchDiffOutput(
  details: ApplyPatchToolCallDetails | undefined
): ToolCallDetailCodeBlock | undefined {
  const diffOperations = details?.operations.filter((op) => op.diff?.trim()) ?? []
  if (diffOperations.length === 0) return undefined

  const value = diffOperations.map((op) => op.diff!.trimEnd()).join('\n\n')
  const label = diffOperations.length === 1 ? `diff: ${diffOperations[0].path}` : 'diff'
  return {
    label,
    value,
    ...(diffOperations.length === 1 ? { filePath: diffOperations[0].path } : {})
  }
}

function buildFallbackOutput(toolCall: ToolCall): ToolCallDetailCodeBlock | undefined {
  const details = toolCall.details
  const error = toolCall.error?.trim()

  if (toolCall.toolName === 'read' && details) {
    const read = details as ReadToolCallDetails
    if (read.content?.trim()) {
      return { label: 'Output', value: read.content.trimEnd() }
    }
  }

  if (toolCall.toolName === 'bash' && details) {
    const bash = details as BashToolCallDetails
    const parts: string[] = []
    if (bash.stdout.trim()) parts.push('stdout:\n' + bash.stdout.trimEnd())
    if (bash.stderr.trim()) parts.push('stderr:\n' + bash.stderr.trimEnd())
    if (error) parts.push('error:\n' + error)
    const value = parts.join('\n\n')
    return value
      ? {
          label: 'Output',
          value,
          ...(toolCall.status === 'failed' ? { tone: 'danger' as const } : {})
        }
      : undefined
  }

  if (toolCall.toolName === 'jsRepl' && details) {
    const repl = details as JsReplToolCallDetails
    const parts: string[] = []
    if (repl.consoleOutput?.trim()) parts.push('console:\n' + repl.consoleOutput.trimEnd())
    if (repl.result?.trim()) parts.push('result:\n' + repl.result.trimEnd())
    if (repl.error?.trim()) parts.push('error:\n' + repl.error.trimEnd())
    if (error) parts.push('error:\n' + error)
    const value = parts.join('\n\n')
    return value
      ? {
          label: 'Output',
          value,
          ...(repl.error || toolCall.status === 'failed' ? { tone: 'danger' as const } : {})
        }
      : undefined
  }

  if (toolCall.toolName === 'webRead' && details) {
    const webRead = details as WebReadToolCallDetails
    const meta = compactJson({
      finalUrl: webRead.finalUrl,
      httpStatus: webRead.httpStatus,
      contentType: webRead.contentType,
      extractor: webRead.extractor,
      title: webRead.title,
      author: webRead.author,
      siteName: webRead.siteName,
      publishedTime: webRead.publishedTime,
      description: webRead.description,
      contentFormat: webRead.contentFormat,
      contentChars: webRead.contentChars,
      truncated: webRead.truncated,
      originalContentChars: webRead.originalContentChars,
      savedFileName: webRead.savedFileName,
      savedFilePath: webRead.savedFilePath,
      savedBytes: webRead.savedBytes,
      failureCode: webRead.failureCode
    })
    const value = [meta, webRead.content].filter(Boolean).join('\n\n')
    return value ? { label: 'Output', value } : undefined
  }

  if (toolCall.toolName === 'grep' && details) {
    return {
      label: 'Output',
      value: compactJson({ matches: (details as GrepToolCallDetails).matches })
    }
  }

  if (toolCall.toolName === 'glob' && details) {
    return {
      label: 'Output',
      value: compactJson({ matches: (details as GlobToolCallDetails).matches })
    }
  }

  if (details) {
    return {
      label: 'Output',
      value: compactJson({
        summary: toolCall.outputSummary,
        error,
        details
      }),
      tone: toolCall.status === 'failed' ? 'danger' : undefined
    }
  }

  const value = error ?? toolCall.outputSummary
  return value ? { label: 'Output', value, tone: error ? 'danger' : undefined } : undefined
}

export function buildToolCallDetailsPresentation(toolCall: ToolCall): ToolCallDetailsPresentation {
  const rawInput = 'rawInput' in toolCall ? toolCall.rawInput : undefined
  const rawOutput = 'rawOutput' in toolCall ? toolCall.rawOutput : undefined
  const inputValue =
    rawInput !== undefined ? renderRawValue(rawInput) : buildFallbackInput(toolCall)
  const metadata = buildFallbackMetadata(toolCall)
  const applyPatchDiffOutput =
    toolCall.toolName === 'applyPatch'
      ? buildApplyPatchDiffOutput(toolCall.details as ApplyPatchToolCallDetails | undefined)
      : undefined
  const output =
    applyPatchDiffOutput ??
    (rawOutput !== undefined
      ? { label: 'Output', value: renderRawValue(rawOutput) }
      : buildFallbackOutput(toolCall))

  return {
    ...(inputValue ? { input: { label: 'Input', value: inputValue } } : {}),
    ...(metadata?.value ? { metadata } : {}),
    ...(output?.value ? { output } : {})
  }
}

export function buildToolCallRowSummary(
  toolCall: ToolCall,
  workspacePath?: string | null
): ToolCallRowSummary {
  const isPathTool =
    toolCall.toolName === 'read' || toolCall.toolName === 'write' || toolCall.toolName === 'edit'
  const inputSummary =
    isPathTool && toolCall.inputSummary
      ? formatToolFilePath(toolCall.inputSummary, workspacePath)
      : toolCall.inputSummary || undefined

  return {
    inputSummary,
    outputSummary:
      toolCall.toolName === 'bash'
        ? buildFixedBashRowStatus(toolCall)
        : toolCall.outputSummary || undefined
  }
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
