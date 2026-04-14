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

/** Return the byte offset of every occurrence of `needle` in `haystack`. */
function findAllMatchPositions(haystack: string, needle: string): number[] {
  const positions: number[] = []
  let index = 0
  while (true) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) return positions
    positions.push(found)
    index = found + needle.length
  }
}

export function createTool(context: AgentToolContext): Tool<EditToolInput, EditToolOutput> {
  return tool({
    description: `Edit an existing text file with a targeted oldText -> newText replacement. Relative paths resolve from ${context.workspacePath}. The edit fails when oldText is missing or ambiguous. Set replace_all to true to replace every occurrence. You must read the file before editing it.`,
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
  let message: string
  if (error) {
    message = error
  } else if (details.replacements > 1) {
    message = `Updated ${path} with ${details.replacements} replacements (first at line ${details.firstChangedLine ?? 1}).`
  } else {
    message =
      `Updated ${path} at line ${details.firstChangedLine ?? 1}.\n\n${details.diff ?? ''}`.trim()
  }

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

    if (occurrences > 1 && !input.replace_all) {
      return createEditResult(
        resolvedPath,
        {
          path: resolvedPath,
          replacements: 0
        },
        'Search text matched multiple locations. Make oldText more specific before retrying, or set replace_all to true.'
      )
    }

    // --- Read-before-edit guard (range-aware) ---
    // Check after locating matches so the error can report the exact lines.
    const matchPositions = findAllMatchPositions(original, input.oldText)
    const oldTextLineSpan = countNewlines(input.oldText) // 0 for single-line oldText
    const matchStartLines = matchPositions.map((pos) => countNewlines(original.slice(0, pos)) + 1)
    const firstChangedLine = matchStartLines[0]

    if (context.readRecordCache) {
      if (!context.readRecordCache.hasRecentRead(resolvedPath)) {
        return createEditResult(
          resolvedPath,
          { path: resolvedPath, replacements: 0 },
          'You must read the file with the read tool before editing it. Read the file first, then retry.'
        )
      }
      // Collect every line touched by every match (start through end of oldText).
      const uncoveredLines: number[] = []
      for (const startLine of matchStartLines) {
        for (let line = startLine; line <= startLine + oldTextLineSpan; line++) {
          if (!context.readRecordCache.coversLine(resolvedPath, line)) {
            uncoveredLines.push(line)
          }
        }
      }
      if (uncoveredLines.length > 0) {
        // Deduplicate and sort for a clean message.
        const unique = [...new Set(uncoveredLines)].sort((a, b) => a - b)
        const lineList =
          unique.length <= 5
            ? unique.join(', ')
            : `${unique.slice(0, 5).join(', ')} and ${unique.length - 5} more`
        return createEditResult(
          resolvedPath,
          { path: resolvedPath, replacements: 0 },
          `The edit targets line${unique.length > 1 ? 's' : ''} ${lineList}, but your most recent read did not cover that region. Read the relevant section first (use offset), then retry.`
        )
      }
    }

    const nextContent = input.replace_all
      ? original.replaceAll(input.oldText, input.newText)
      : original.replace(input.oldText, input.newText)
    await writeFile(resolvedPath, nextContent, { encoding: 'utf8', signal: abortSignal })

    const matchStart = matchPositions[0]
    let diff: string | undefined
    if (occurrences === 1) {
      diff = buildEditDiff(
        resolvedPath,
        original,
        nextContent,
        matchStart,
        input.oldText,
        input.newText
      ).diff
    }

    return createEditResult(resolvedPath, {
      path: resolvedPath,
      replacements: occurrences,
      firstChangedLine,
      ...(diff ? { diff } : {})
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
