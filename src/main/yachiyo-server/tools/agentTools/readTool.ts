import { tool, type Tool } from 'ai'

import { createHash } from 'node:crypto'
import { extname, join } from 'node:path'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'

import type { ReadToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import { extractPdfText } from '../../services/pdfExtract.ts'

import {
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_MAX_BYTES,
  type AgentToolContext,
  type ReadToolInput,
  type ReadToolOutput,
  readToolInputSchema,
  raceAgainstSignal,
  resolveSandboxedToolPath,
  resolveUnicodeSpacePath,
  imageDataContent,
  textContent,
  toToolModelOutput,
  truncateUtf8ByBytes
} from './shared.ts'

const DEFAULT_READ_TIMEOUT_MS = 30_000
const INSPECT_READ_TIMEOUT_MS = 90_000

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.ico': 'image/x-icon'
}

// Known binary formats that cannot be inlined — return a clear error instead of garbled bytes.
const UNREADABLE_BINARY_EXTENSIONS = new Set([
  // video
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.flv',
  '.wmv',
  '.m4v',
  // audio
  '.mp3',
  '.wav',
  '.aac',
  '.flac',
  '.ogg',
  '.m4a',
  '.wma',
  // archives
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  // executables / compiled
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.wasm',
  // other large binary
  '.iso',
  '.dmg',
  '.pkg'
])

function isPdfFile(filePath: string): boolean {
  return extname(filePath).toLowerCase() === '.pdf'
}

function detectImageMimeType(filePath: string): string | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

function isUnreadableBinary(filePath: string): boolean {
  return UNREADABLE_BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export function createTool(context: AgentToolContext): Tool<ReadToolInput, ReadToolOutput> {
  return tool({
    description: `Read a file from the current thread workspace or an absolute path. Supports text files (with offset/limit pagination), PDF files (text extraction), and common image formats (png, jpg, webp, gif, bmp, tiff, avif, heic, ico). Binary formats like video and audio are not supported. Relative paths resolve from ${context.workspacePath}. Offset is a 1-based line number — use it to start reading at a specific line.`,
    inputSchema: readToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) => runReadTool(input, context, options)
  })
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
  /** True when only a partial first line was returned (byte-truncated). */
  byteTruncatedFirstLine: boolean
} {
  // offset is 1-based (line number). Clamp 0→1 for backward compatibility.
  const offset = Math.max(input.offset ?? 1, 1)
  const limit = input.limit ?? DEFAULT_READ_LIMIT
  const idx = offset - 1

  if (idx >= lines.length) {
    return {
      excerpt: '',
      endLine: offset - 1,
      truncated: false,
      byteTruncatedFirstLine: false
    }
  }

  const selectedLines: string[] = []
  let bytes = 0
  let consumedLines = 0
  let truncatedByBytes = false
  let returnedPartialFirstLine = false

  for (const line of lines.slice(idx, idx + limit)) {
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
  const remainingLines = Math.max(lines.length - nextOffset + 1, 0)
  const truncated = truncatedByBytes || remainingLines > 0

  return {
    excerpt: selectedLines.join('\n'),
    endLine:
      consumedLines === 0
        ? returnedPartialFirstLine
          ? offset
          : offset - 1
        : offset + consumedLines - 1,
    ...(truncated ? { nextOffset } : {}),
    ...(truncated ? { remainingLines } : {}),
    truncated,
    byteTruncatedFirstLine: returnedPartialFirstLine
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

const PDF_CACHE_DIR = '.yachiyo/tool-result'

function pdfCachePath(workspacePath: string, hash: string): string {
  return join(workspacePath, PDF_CACHE_DIR, `pdf-${hash}.txt`)
}

async function tryReadPdfCache(cachePath: string): Promise<string | undefined> {
  try {
    return await readFile(cachePath, 'utf8')
  } catch {
    return undefined
  }
}

async function runPdfReadTool(
  input: ReadToolInput,
  resolvedPath: string,
  context: AgentToolContext,
  abortSignal?: AbortSignal
): Promise<ReadToolOutput> {
  const fileData = await readFile(resolvedPath, { signal: abortSignal })
  const fileStat = await (abortSignal
    ? raceAgainstSignal(stat(resolvedPath), abortSignal)
    : stat(resolvedPath))
  const hash = createHash('sha256').update(fileData).digest('hex').slice(0, 16)
  const cachePath = pdfCachePath(context.workspacePath, hash)

  let body: string
  let totalPages: number
  let cached: boolean

  // Try cached extraction first
  const cachedText = await tryReadPdfCache(cachePath)
  if (cachedText) {
    const pageMatch = /Pages: (\d+)/.exec(cachedText)
    body = cachedText
    totalPages = pageMatch ? Number(pageMatch[1]) : 0
    cached = true
  } else {
    // Extract and cache — unpdf doesn't accept an abort signal, so race it.
    const pdf = abortSignal
      ? await raceAgainstSignal(extractPdfText(fileData), abortSignal)
      : await extractPdfText(fileData)
    body = pdf.hint ? `${pdf.text}\n\n${pdf.hint}` : pdf.text
    totalPages = pdf.totalPages
    cached = false

    try {
      await mkdir(join(context.workspacePath, PDF_CACHE_DIR), { recursive: true })
      await writeFile(cachePath, body, 'utf8')
    } catch {
      // Cache write failure is non-fatal
    }
  }

  // Paginate the extracted text using the same logic as regular text files
  const lines = body.length === 0 ? [] : body.split(/\r?\n/)
  const excerpt = buildReadExcerpt(lines, input)
  const continuationHint =
    excerpt.truncated && excerpt.nextOffset !== undefined
      ? `\n\n[truncated: continue with offset ${excerpt.nextOffset}]`
      : ''

  const details: ReadToolCallDetails = {
    path: resolvedPath,
    startLine: Math.max(input.offset ?? 1, 1),
    endLine: excerpt.endLine,
    totalLines: lines.length,
    totalBytes: fileStat.size,
    truncated: excerpt.truncated,
    ...(excerpt.nextOffset !== undefined ? { nextOffset: excerpt.nextOffset } : {}),
    ...(excerpt.remainingLines !== undefined ? { remainingLines: excerpt.remainingLines } : {}),
    mediaType: 'application/pdf',
    totalPages,
    cached
  }

  return { content: textContent(`${excerpt.excerpt}${continuationHint}`), details, metadata: {} }
}

async function runImageReadTool(
  resolvedPath: string,
  mediaType: string,
  context: AgentToolContext,
  abortSignal?: AbortSignal,
  focus?: string
): Promise<ReadToolOutput> {
  const fileData = await readFile(resolvedPath, { signal: abortSignal })
  const fileStat = await (abortSignal
    ? raceAgainstSignal(stat(resolvedPath), abortSignal)
    : stat(resolvedPath))
  const base64 = fileData.toString('base64')
  const filename = resolvedPath.split('/').pop() ?? resolvedPath
  const summary = `Read image ${filename} (${mediaType}, ${fileStat.size} bytes)`

  const details: ReadToolCallDetails = {
    path: resolvedPath,
    startLine: 0,
    endLine: 0,
    totalLines: 0,
    totalBytes: fileStat.size,
    truncated: false,
    mediaType
  }

  if (focus?.trim() && context.imageToTextService) {
    const dataUrl = `data:${mediaType};base64,${base64}`
    const result = await context.imageToTextService.inspect(dataUrl, focus.trim(), abortSignal)
    return {
      content: textContent(`${result ?? '(image could not be inspected)'}\n${summary}`),
      details,
      metadata: {}
    }
  }

  if (context.isModelImageCapable === false && context.imageToTextService) {
    const dataUrl = `data:${mediaType};base64,${base64}`
    const result = await context.imageToTextService.describe(dataUrl)
    const altText = result?.altText ?? '(image could not be described)'
    return {
      content: textContent(`[Image: ${altText}]\n${summary}`),
      details,
      metadata: {}
    }
  }

  return {
    content: [...imageDataContent(base64, mediaType), ...textContent(summary)],
    details,
    metadata: {}
  }
}

export async function runReadTool(
  input: ReadToolInput,
  context: AgentToolContext,
  options: { abortSignal?: AbortSignal } = {}
): Promise<ReadToolOutput> {
  const userSignal = options.abortSignal
  const isInspect = !!input.focus?.trim()
  const timeoutMs = isInspect ? INSPECT_READ_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const effectiveSignal = userSignal ? AbortSignal.any([timeoutSignal, userSignal]) : timeoutSignal

  const focusIgnoredHint = isInspect ? '\n\n[Note: focus is only supported for image files]' : ''

  const pathResult = resolveSandboxedToolPath(context, input.path)
  if ('error' in pathResult) {
    return createReadErrorResult(input.path, pathResult.error)
  }
  const resolvedPath = await resolveUnicodeSpacePath(pathResult.resolved, effectiveSignal)

  if (isUnreadableBinary(resolvedPath)) {
    const ext = extname(resolvedPath).toLowerCase()
    return createReadErrorResult(
      resolvedPath,
      `Cannot read ${ext} files — binary format not supported for inline reading.`
    )
  }

  if (isPdfFile(resolvedPath)) {
    try {
      const pdfResult = await runPdfReadTool(input, resolvedPath, context, effectiveSignal)
      if (focusIgnoredHint) {
        pdfResult.content = [...pdfResult.content, ...textContent(focusIgnoredHint)]
      }
      return pdfResult
    } catch (error) {
      return createReadErrorResult(
        resolvedPath,
        error instanceof Error ? error.message : 'Unable to read PDF file.'
      )
    }
  }

  const imageMimeType = detectImageMimeType(resolvedPath)
  if (imageMimeType) {
    try {
      return await runImageReadTool(
        resolvedPath,
        imageMimeType,
        context,
        effectiveSignal,
        input.focus
      )
    } catch (error) {
      return createReadErrorResult(
        resolvedPath,
        error instanceof Error ? error.message : 'Unable to read image file.'
      )
    }
  }

  try {
    const rawContent = await readFile(resolvedPath, { encoding: 'utf8', signal: effectiveSignal })
    const lines = rawContent.length === 0 ? [] : rawContent.split(/\r?\n/)
    const excerpt = buildReadExcerpt(lines, input)
    const details: ReadToolCallDetails = {
      path: resolvedPath,
      startLine: Math.max(input.offset ?? 1, 1),
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

    if (context.readRecordCache) {
      const mtimeMs = await (
        effectiveSignal
          ? raceAgainstSignal(stat(resolvedPath), effectiveSignal)
          : stat(resolvedPath)
      ).then(
        (s) => s.mtimeMs,
        () => undefined
      )
      if (lines.length === 0) {
        context.readRecordCache.recordEmptyFileRead(resolvedPath, mtimeMs)
      } else {
        const guardEndLine = excerpt.byteTruncatedFirstLine ? details.endLine - 1 : details.endLine
        context.readRecordCache.recordRead(resolvedPath, details.startLine, guardEndLine, mtimeMs)
      }
    }
    return {
      content: textContent(`${excerpt.excerpt}${continuationHint}${focusIgnoredHint}`),
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
