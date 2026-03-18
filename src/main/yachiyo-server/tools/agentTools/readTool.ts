import { tool, type Tool } from 'ai'

import { readFile } from 'node:fs/promises'

import type { ReadToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

import {
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_MAX_BYTES,
  type AgentToolContext,
  type ReadToolInput,
  type ReadToolOutput,
  readToolInputSchema,
  resolveToolPath,
  textContent,
  toToolModelOutput,
  truncateUtf8ByBytes
} from './shared.ts'

export function createTool(context: AgentToolContext): Tool<ReadToolInput, ReadToolOutput> {
  return tool({
    description: `Read a text file from the current thread workspace or an absolute path. Relative paths resolve from ${context.workspacePath}. Use offset as a 0-based line continuation cursor.`,
    inputSchema: readToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input) => runReadTool(input, context)
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

export async function runReadTool(
  input: ReadToolInput,
  context: AgentToolContext
): Promise<ReadToolOutput> {
  const resolvedPath = resolveToolPath(context.workspacePath, input.path)

  try {
    const rawContent = await readFile(resolvedPath, 'utf8')
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
