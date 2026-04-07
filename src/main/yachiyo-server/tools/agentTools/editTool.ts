import { tool, type Tool } from 'ai'

import { readFile, writeFile } from 'node:fs/promises'

import type { EditToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

import {
  countNewlines,
  countOccurrences,
  type AgentToolContext,
  type EditToolInput,
  type EditToolOutput,
  editToolInputSchema,
  resolveToolPath,
  resolveUnicodeSpacePath,
  textContent,
  toToolModelOutput
} from './shared.ts'

export function createTool(context: AgentToolContext): Tool<EditToolInput, EditToolOutput> {
  return tool({
    description: `Edit an existing text file with a targeted oldText -> newText replacement. Relative paths resolve from ${context.workspacePath}. The edit fails when oldText is missing or ambiguous.`,
    inputSchema: editToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) => runEditTool(input, context, options)
  })
}

function buildEditDiff(
  path: string,
  original: string,
  nextContent: string,
  matchStart: number,
  oldText: string,
  newText: string
): { diff: string; firstChangedLine: number } {
  const contextLineCount = 2
  const firstChangedLine = countNewlines(original.slice(0, matchStart)) + 1
  const lastOldChangedLine = countNewlines(original.slice(0, matchStart + oldText.length)) + 1
  const lastNewChangedLine =
    newText.length === 0
      ? firstChangedLine
      : countNewlines(nextContent.slice(0, matchStart + newText.length)) + 1

  const originalLines = original.length === 0 ? [] : original.split(/\r?\n/)
  const nextLines = nextContent.length === 0 ? [] : nextContent.split(/\r?\n/)

  const oldStartLine = Math.max(1, firstChangedLine - contextLineCount)
  const newStartLine = Math.max(1, firstChangedLine - contextLineCount)

  const beforeLines = originalLines.slice(oldStartLine - 1, firstChangedLine - 1)
  const oldChangedLines = originalLines.slice(firstChangedLine - 1, lastOldChangedLine)
  const newChangedLines = nextLines.slice(firstChangedLine - 1, lastNewChangedLine)
  const afterLines = nextLines.slice(
    lastNewChangedLine,
    Math.min(nextLines.length, lastNewChangedLine + contextLineCount)
  )

  const oldBlockCount = beforeLines.length + oldChangedLines.length + afterLines.length
  const newBlockCount = beforeLines.length + newChangedLines.length + afterLines.length

  const diff = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${oldStartLine},${oldBlockCount} +${newStartLine},${newBlockCount} @@`,
    ...beforeLines.map((line) => ` ${line}`),
    ...oldChangedLines.map((line) => `-${line}`),
    ...newChangedLines.map((line) => `+${line}`),
    ...afterLines.map((line) => ` ${line}`)
  ].join('\n')

  return {
    diff,
    firstChangedLine
  }
}

function createEditResult(
  path: string,
  details: EditToolCallDetails,
  error?: string
): EditToolOutput {
  const message =
    error ??
    `Updated ${path} at line ${details.firstChangedLine ?? 1}.\n\n${details.diff ?? ''}`.trim()

  return {
    content: textContent(message),
    details,
    ...(error ? { error } : {}),
    metadata: {}
  }
}

export async function runEditTool(
  input: EditToolInput,
  context: AgentToolContext,
  options: { abortSignal?: AbortSignal } = {}
): Promise<EditToolOutput> {
  const abortSignal = options.abortSignal
  const resolvedPath = await resolveUnicodeSpacePath(
    resolveToolPath(context.workspacePath, input.path)
  )

  try {
    const original = await readFile(resolvedPath, { encoding: 'utf8', signal: abortSignal })
    const occurrences = countOccurrences(original, input.oldText)

    if (occurrences === 0) {
      return createEditResult(
        resolvedPath,
        {
          path: resolvedPath,
          replacements: 0
        },
        'Search text was not found in the target file.'
      )
    }

    if (occurrences > 1) {
      return createEditResult(
        resolvedPath,
        {
          path: resolvedPath,
          replacements: 0
        },
        'Search text matched multiple locations. Make oldText more specific before retrying.'
      )
    }

    const matchStart = original.indexOf(input.oldText)
    const nextContent = original.replace(input.oldText, input.newText)
    await writeFile(resolvedPath, nextContent, { encoding: 'utf8', signal: abortSignal })

    const diff = buildEditDiff(
      resolvedPath,
      original,
      nextContent,
      matchStart,
      input.oldText,
      input.newText
    )

    return createEditResult(resolvedPath, {
      path: resolvedPath,
      replacements: 1,
      diff: diff.diff,
      firstChangedLine: diff.firstChangedLine
    })
  } catch (error) {
    return createEditResult(
      resolvedPath,
      {
        path: resolvedPath,
        replacements: 0
      },
      error instanceof Error ? error.message : 'Unable to edit file.'
    )
  }
}
