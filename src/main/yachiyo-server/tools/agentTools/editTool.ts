import { tool, type Tool } from 'ai'

import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

import type { EditToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

import {
  countNewlines,
  countOccurrences,
  expandTilde,
  type AgentToolContext,
  type EditSpec,
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
    description: `Edit an existing text file. You must choose one explicit mode. (1) Inline replacement: \`{ mode: 'inline', oldText, newText, replace_all? }\` — best for short surgical edits where the match is stable. (2) Line-range replacement: \`{ mode: 'range', replaceLines: { start, end }, newText }\` — addresses lines by position (1-indexed, inclusive) using the same coordinates the read tool returned. Prefer this for multi-line block rewrites where reproducing exact whitespace via oldText is error-prone. (3) Batched inline edits: \`{ mode: 'batch', edits: [{ oldText, newText, replace_all? }, ...] }\` — applies multiple inline edits to the same file atomically. Relative paths resolve from ${context.workspacePath}; files outside the workspace require an absolute path. Every shape requires you to have read the target region first.`,
    inputSchema: editToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) => runEditTool(input, context, options)
  })
}

function normalizeEdits(input: EditToolInput): EditSpec[] {
  if (input.mode === 'batch') {
    if (!input.edits || input.edits.length === 0) {
      throw new Error('Batch edit requires a non-empty edits array.')
    }
    return input.edits
  }
  if (input.mode !== 'inline') {
    throw new Error(
      `normalizeEdits only supports inline or batch inputs, received mode "${input.mode}".`
    )
  }
  if (!input.oldText) {
    throw new Error('Inline edit requires a non-empty oldText.')
  }
  if (input.newText === undefined) {
    throw new Error('Inline edit requires newText.')
  }
  return [
    { oldText: input.oldText, newText: input.newText, replace_all: input.replace_all ?? false }
  ]
}

function isInputEffectivelyAbsolute(rawPath: string): boolean {
  const unquoted = rawPath.trim().replace(/^(['"`])(.*)\1$/, '$2')
  return isAbsolute(expandTilde(unquoted))
}

function isPathInsideWorkspace(workspacePath: string, resolvedPath: string): boolean {
  const rel = relative(workspacePath, resolvedPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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

function createEmptyEditDetails(
  path: string,
  mode: EditToolCallDetails['mode']
): EditToolCallDetails {
  return {
    path,
    mode,
    replacements: 0
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
  const emptyDetails = createEmptyEditDetails(resolvedPath, input.mode)

  // --- Fast-path absolute-path-outside-workspace guard (pre-stat) ---
  // Cheap string-level check catches obvious `..` escapes before any filesystem I/O.
  // The realpath-based check below handles the symlink case.
  if (
    !isInputEffectivelyAbsolute(input.path) &&
    !isPathInsideWorkspace(context.workspacePath, resolvedPath)
  ) {
    return createEditResult(
      resolvedPath,
      emptyDetails,
      `Relative path \`${input.path}\` escapes the workspace. Use an absolute path to edit files outside ${context.workspacePath}.`
    )
  }

  // --- Explicit file existence + type checks ---
  try {
    const info = await stat(resolvedPath)
    if (!info.isFile()) {
      return createEditResult(
        resolvedPath,
        emptyDetails,
        `\`${resolvedPath}\` is not a regular file.`
      )
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return createEditResult(resolvedPath, emptyDetails, `File not found at \`${resolvedPath}\`.`)
    }
    return createEditResult(
      resolvedPath,
      emptyDetails,
      err instanceof Error ? err.message : 'Unable to access file.'
    )
  }

  // --- Symlink-aware workspace escape guard (post-stat) ---
  // stat() and writeFile() follow symlinks, so a relative `link.txt` that points outside
  // the workspace would slip past the string-only check above. Canonicalize both sides
  // via realpath and re-check containment. Only enforced for relative inputs — absolute
  // paths are an explicit, opt-in escape hatch.
  if (!isInputEffectivelyAbsolute(input.path)) {
    try {
      const [realResolved, realWorkspace] = await Promise.all([
        realpath(resolvedPath),
        realpath(context.workspacePath)
      ])
      if (!isPathInsideWorkspace(realWorkspace, realResolved)) {
        return createEditResult(
          resolvedPath,
          emptyDetails,
          `Relative path \`${input.path}\` resolves outside the workspace via a symlink. Use an absolute path to edit files outside ${context.workspacePath}.`
        )
      }
    } catch (err) {
      return createEditResult(
        resolvedPath,
        emptyDetails,
        err instanceof Error ? err.message : 'Unable to canonicalize path.'
      )
    }
  }

  if (input.mode === 'range') {
    return runRangedEdit(resolvedPath, input, context, abortSignal)
  }

  const edits = normalizeEdits(input)
  const batched = edits.length > 1
  const editLabel = (i: number): string => (batched ? `Edit ${i + 1}: ` : '')

  try {
    const original = await readFile(resolvedPath, { encoding: 'utf8', signal: abortSignal })

    // --- Read-before-edit guard ---
    // Coverage requirements are derived from the ORIGINAL content: that's what the model
    // actually saw when planning the batch. If an edit's oldText does not appear in the
    // original at all (e.g., it targets content synthesized by an earlier edit), skip its
    // coverage requirement here; the per-edit apply step will catch it cleanly.
    if (context.readRecordCache) {
      const currentMtimeMs = await stat(resolvedPath).then(
        (s) => s.mtimeMs,
        () => undefined
      )
      if (!context.readRecordCache.hasRecentRead(resolvedPath, currentMtimeMs)) {
        return createEditResult(
          resolvedPath,
          emptyDetails,
          'You must read the file with the read tool before editing it. Read the file first, then retry.'
        )
      }
      const uncoveredLines = new Set<number>()
      for (const edit of edits) {
        const positions = findAllMatchPositions(original, edit.oldText)
        if (positions.length === 0) continue
        const requireAll = edit.replace_all || batched
        const targets = requireAll ? positions : positions.slice(0, 1)
        const span = countNewlines(edit.oldText)
        for (const pos of targets) {
          const startLine = countNewlines(original.slice(0, pos)) + 1
          for (let line = startLine; line <= startLine + span; line++) {
            if (!context.readRecordCache.coversLine(resolvedPath, line, currentMtimeMs)) {
              uncoveredLines.add(line)
            }
          }
        }
      }
      if (uncoveredLines.size > 0) {
        const unique = [...uncoveredLines].sort((a, b) => a - b)
        const lineList =
          unique.length <= 5
            ? unique.join(', ')
            : `${unique.slice(0, 5).join(', ')} and ${unique.length - 5} more`
        return createEditResult(
          resolvedPath,
          emptyDetails,
          `The edit targets line${unique.length > 1 ? 's' : ''} ${lineList}, but your most recent read did not cover that region. Read the relevant section first (use offset), then retry.`
        )
      }
    }

    if (context.snapshotTracker) {
      await context.snapshotTracker.trackBeforeWrite(resolvedPath)
    }

    let content = original
    const hunks: string[] = []
    let totalReplacements = 0
    let firstChangedLineOverall: number | undefined

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]
      const occurrences = countOccurrences(content, edit.oldText)

      if (occurrences === 0) {
        return createEditResult(
          resolvedPath,
          emptyDetails,
          `${editLabel(i)}Search text was not found in the ${batched ? 'current file state (a prior edit may have altered it).' : 'target file.'}`
        )
      }
      if (occurrences > 1 && !edit.replace_all) {
        return createEditResult(
          resolvedPath,
          emptyDetails,
          `${editLabel(i)}Search text matched multiple locations. Make oldText more specific before retrying, or set replace_all to true.`
        )
      }

      const pre = content
      const matchStart = pre.indexOf(edit.oldText)
      const next = edit.replace_all
        ? pre.replaceAll(edit.oldText, edit.newText)
        : pre.replace(edit.oldText, edit.newText)

      if (occurrences === 1) {
        const hunk = buildEditDiff(resolvedPath, pre, next, matchStart, edit.oldText, edit.newText)
        hunks.push(hunk.diff)
        firstChangedLineOverall = Math.min(
          firstChangedLineOverall ?? hunk.firstChangedLine,
          hunk.firstChangedLine
        )
      } else {
        const startLine = countNewlines(pre.slice(0, matchStart)) + 1
        firstChangedLineOverall = Math.min(firstChangedLineOverall ?? startLine, startLine)
      }

      totalReplacements += occurrences
      content = next
    }

    // Post-apply safety net: edits that collectively no-op (rare, but possible if a
    // later edit reverses an earlier one, or every replacement substitutes identical text).
    if (content === original) {
      return createEditResult(
        resolvedPath,
        emptyDetails,
        'No net changes were produced by the provided edits.'
      )
    }

    await writeFile(resolvedPath, content, { encoding: 'utf8', signal: abortSignal })

    if (context.readRecordCache) {
      const newMtimeMs = await stat(resolvedPath).then(
        (s) => s.mtimeMs,
        () => undefined
      )
      if (newMtimeMs !== undefined) {
        context.readRecordCache.refreshMtime(resolvedPath, newMtimeMs)
      }
    }

    const diff = hunks.length > 0 ? hunks.join('\n\n') : undefined

    return createEditResult(resolvedPath, {
      path: resolvedPath,
      mode: input.mode,
      replacements: totalReplacements,
      firstChangedLine: firstChangedLineOverall,
      ...(diff ? { diff } : {})
    })
  } catch (error) {
    return createEditResult(
      resolvedPath,
      emptyDetails,
      error instanceof Error ? error.message : 'Unable to edit file.'
    )
  }
}

async function runRangedEdit(
  resolvedPath: string,
  input: EditToolInput,
  context: AgentToolContext,
  abortSignal: AbortSignal | undefined
): Promise<EditToolOutput> {
  const emptyDetails = createEmptyEditDetails(resolvedPath, 'range')
  if (
    input.mode !== 'range' ||
    !input.replaceLines ||
    typeof input.replaceLines !== 'object' ||
    !('start' in input.replaceLines) ||
    !('end' in input.replaceLines) ||
    typeof input.replaceLines.start !== 'number' ||
    typeof input.replaceLines.end !== 'number'
  ) {
    throw new Error('Range edit requires replaceLines with numeric start and end.')
  }
  if (input.newText === undefined) {
    throw new Error('Range edit requires newText.')
  }
  const { start, end } = input.replaceLines
  if (end < start) {
    return createEditResult(
      resolvedPath,
      emptyDetails,
      `Invalid range: end (${end}) must be >= start (${start}).`
    )
  }

  try {
    const original = await readFile(resolvedPath, { encoding: 'utf8', signal: abortSignal })
    const originalLines = original.length === 0 ? [] : original.split(/\r?\n/)
    const totalLines = originalLines.length

    if (start > totalLines) {
      return createEditResult(
        resolvedPath,
        emptyDetails,
        `Range start ${start} is past end of file (file has ${totalLines} line${totalLines === 1 ? '' : 's'}).`
      )
    }
    if (end > totalLines) {
      return createEditResult(
        resolvedPath,
        emptyDetails,
        `Range end ${end} is past end of file (file has ${totalLines} line${totalLines === 1 ? '' : 's'}).`
      )
    }

    // --- Read-before-edit guard (range-aware) ---
    if (context.readRecordCache) {
      const currentMtimeMs = await stat(resolvedPath).then(
        (s) => s.mtimeMs,
        () => undefined
      )
      if (!context.readRecordCache.hasRecentRead(resolvedPath, currentMtimeMs)) {
        return createEditResult(
          resolvedPath,
          emptyDetails,
          'You must read the file with the read tool before editing it. Read the file first, then retry.'
        )
      }
      const uncoveredLines: number[] = []
      for (let line = start; line <= end; line++) {
        if (!context.readRecordCache.coversLine(resolvedPath, line, currentMtimeMs)) {
          uncoveredLines.push(line)
        }
      }
      if (uncoveredLines.length > 0) {
        const lineList =
          uncoveredLines.length <= 5
            ? uncoveredLines.join(', ')
            : `${uncoveredLines.slice(0, 5).join(', ')} and ${uncoveredLines.length - 5} more`
        return createEditResult(
          resolvedPath,
          emptyDetails,
          `The edit targets line${uncoveredLines.length > 1 ? 's' : ''} ${lineList}, but your most recent read did not cover that region. Read the relevant section first (use offset), then retry.`
        )
      }
    }

    if (context.snapshotTracker) {
      await context.snapshotTracker.trackBeforeWrite(resolvedPath)
    }

    // Preserve the file's existing line-ending style. If the file uses CRLF anywhere,
    // rebuild with CRLF; otherwise LF. Prevents a ranged edit from silently converting
    // every untouched line's line-ending on a CRLF file.
    const eol = original.includes('\r\n') ? '\r\n' : '\n'

    // Splice the range. originalLines is 0-indexed; input range is 1-indexed inclusive.
    // newText from the model may use LF or CRLF; split tolerantly and rejoin with eol.
    // Note: ''.split(/\r?\n/) === ['']. An empty newText therefore replaces the range with
    // a single empty line — NOT zero lines — which preserves the file's trailing newline
    // when the phantom last line (the empty element produced by a trailing \n) is targeted.
    const newLines = input.newText.split(/\r?\n/)
    const nextLines = [
      ...originalLines.slice(0, start - 1),
      ...newLines,
      ...originalLines.slice(end)
    ]
    const nextContent = nextLines.join(eol)

    if (nextContent === original) {
      return createEditResult(
        resolvedPath,
        emptyDetails,
        'No changes: newText is identical to the current contents of the target range.'
      )
    }

    await writeFile(resolvedPath, nextContent, { encoding: 'utf8', signal: abortSignal })

    if (context.readRecordCache) {
      const newMtimeMs = await stat(resolvedPath).then(
        (s) => s.mtimeMs,
        () => undefined
      )
      if (newMtimeMs !== undefined) {
        context.readRecordCache.refreshMtime(resolvedPath, newMtimeMs)
      }
    }

    // Build a diff hunk using the existing helper. buildEditDiff splits on /\r?\n/ itself,
    // so it works identically for LF and CRLF source.
    const preSliceByteOffset = originalLines
      .slice(0, start - 1)
      .reduce((sum, line) => sum + line.length + eol.length, 0)
    const oldSliceText = originalLines.slice(start - 1, end).join(eol)
    const newSliceText = newLines.join(eol)
    const { diff } = buildEditDiff(
      resolvedPath,
      original,
      nextContent,
      preSliceByteOffset,
      oldSliceText,
      newSliceText
    )

    return createEditResult(resolvedPath, {
      path: resolvedPath,
      mode: 'range',
      replacements: 1,
      firstChangedLine: start,
      diff
    })
  } catch (error) {
    return createEditResult(
      resolvedPath,
      emptyDetails,
      error instanceof Error ? error.message : 'Unable to edit file.'
    )
  }
}
