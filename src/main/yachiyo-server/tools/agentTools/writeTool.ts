import { tool, type Tool } from 'ai'

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { WriteToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

import {
  type AgentToolContext,
  type WriteToolInput,
  type WriteToolOutput,
  hasAccess,
  resolveToolPath,
  resolveUnicodeSpacePath,
  textContent,
  toToolModelOutput,
  writeToolInputSchema
} from './shared.ts'

const PREVIEW_MAX_LINES = 120
const PREVIEW_MAX_CHARS = 10000

function truncatePreview(content: string): string | undefined {
  if (!content) return undefined
  const lines = content.split('\n')
  if (lines.length <= PREVIEW_MAX_LINES && content.length <= PREVIEW_MAX_CHARS) return content
  const sliced = lines.slice(0, PREVIEW_MAX_LINES).join('\n')
  return sliced.length > PREVIEW_MAX_CHARS ? sliced.slice(0, PREVIEW_MAX_CHARS) : sliced
}

export function createTool(context: AgentToolContext): Tool<WriteToolInput, WriteToolOutput> {
  return tool({
    description: `Write a text file in the current thread workspace or at an absolute path. Relative paths resolve from ${context.workspacePath}. Parent directories are created automatically and existing files are overwritten. When overwriting an existing file, you must read it first.`,
    inputSchema: writeToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) => runWriteTool(input, context, options)
  })
}

function createWriteResult(
  path: string,
  details: WriteToolCallDetails,
  error?: string
): WriteToolOutput {
  const action = details.overwritten ? 'Overwrote' : 'Wrote'
  const message = error ?? `${action} ${details.bytesWritten} bytes to ${path}.`

  return {
    content: textContent(message),
    details,
    ...(error ? { error } : {}),
    metadata: {}
  }
}

export async function runWriteTool(
  input: WriteToolInput,
  context: AgentToolContext,
  options: { abortSignal?: AbortSignal } = {}
): Promise<WriteToolOutput> {
  const abortSignal = options.abortSignal
  const resolvedPath = await resolveUnicodeSpacePath(
    resolveToolPath(context.workspacePath, input.path)
  )

  try {
    const exists = await hasAccess(resolvedPath)

    const currentMtimeMs = exists
      ? await stat(resolvedPath).then(
          (s) => s.mtimeMs,
          () => undefined
        )
      : undefined
    if (
      exists &&
      context.readRecordCache &&
      !context.readRecordCache.hasRecentRead(resolvedPath, currentMtimeMs)
    ) {
      return createWriteResult(
        resolvedPath,
        { path: resolvedPath, bytesWritten: 0, created: false, overwritten: false },
        'You must read the file with the read tool before overwriting it. Read the file first, then retry.'
      )
    }

    if (context.snapshotTracker) {
      await context.snapshotTracker.trackBeforeWrite(resolvedPath)
    }

    await mkdir(dirname(resolvedPath), { recursive: true })
    await writeFile(resolvedPath, input.content, { encoding: 'utf8', signal: abortSignal })

    if (context.readRecordCache) {
      const newMtimeMs = await stat(resolvedPath).then(
        (s) => s.mtimeMs,
        () => undefined
      )
      if (newMtimeMs !== undefined) {
        const lineCount = input.content.split('\n').length
        context.readRecordCache.recordRead(resolvedPath, 1, lineCount, newMtimeMs)
      }
    }

    return createWriteResult(resolvedPath, {
      path: resolvedPath,
      bytesWritten: Buffer.byteLength(input.content, 'utf8'),
      created: !exists,
      overwritten: exists,
      contentPreview: truncatePreview(input.content)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to write file.'
    return createWriteResult(
      resolvedPath,
      {
        path: resolvedPath,
        bytesWritten: 0,
        created: false,
        overwritten: false
      },
      message
    )
  }
}
