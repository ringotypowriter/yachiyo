import { tool, type Tool } from 'ai'

import { extname } from 'node:path'
import { readFile, stat } from 'node:fs/promises'

import type { ReadToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

import {
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_MAX_BYTES,
  type AgentToolContext,
  type ReadToolInput,
  type ReadToolOutput,
  readToolInputSchema,
  resolveSandboxedToolPath,
  resolveUnicodeSpacePath,
  imageDataContent,
  textContent,
  toToolModelOutput,
  truncateUtf8ByBytes
} from './shared.ts'

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
  // documents
  '.pdf',
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

function detectImageMimeType(filePath: string): string | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

function isUnreadableBinary(filePath: string): boolean {
  return UNREADABLE_BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export function createTool(context: AgentToolContext): Tool<ReadToolInput, ReadToolOutput> {
  return tool({
    description: `Read a file from the current thread workspace or an absolute path. Supports text files (with offset/limit pagination) and common image formats (png, jpg, webp, gif, bmp, tiff, avif, heic, ico). Binary formats like video, audio, and PDF are not supported. Relative paths resolve from ${context.workspacePath}. Use offset as a 0-based line continuation cursor for text files.`,
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

async function runImageReadTool(
  resolvedPath: string,
  mediaType: string,
  abortSignal?: AbortSignal
): Promise<ReadToolOutput> {
  const fileData = await readFile(resolvedPath, { signal: abortSignal })
  const fileStat = await stat(resolvedPath)
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
  const abortSignal = options.abortSignal
  const pathResult = resolveSandboxedToolPath(context, input.path)
  if ('error' in pathResult) {
    return createReadErrorResult(input.path, pathResult.error)
  }
  const resolvedPath = await resolveUnicodeSpacePath(pathResult.resolved)

  if (isUnreadableBinary(resolvedPath)) {
    const ext = extname(resolvedPath).toLowerCase()
    return createReadErrorResult(
      resolvedPath,
      `Cannot read ${ext} files — binary format not supported for inline reading.`
    )
  }

  const imageMimeType = detectImageMimeType(resolvedPath)
  if (imageMimeType) {
    try {
      return await runImageReadTool(resolvedPath, imageMimeType, abortSignal)
    } catch (error) {
      return createReadErrorResult(
        resolvedPath,
        error instanceof Error ? error.message : 'Unable to read image file.'
      )
    }
  }

  try {
    const rawContent = await readFile(resolvedPath, { encoding: 'utf8', signal: abortSignal })
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
