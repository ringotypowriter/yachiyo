import { tool, type Tool } from 'ai'
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'node:path'

import { createTwoFilesPatch } from 'diff'

import type { ApplyPatchToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

import {
  type AgentToolContext,
  type ApplyPatchToolInput,
  type ApplyPatchToolOutput,
  applyPatchToolInputSchema,
  resolveToolPath,
  resolveUnicodeSpacePath,
  textContent,
  toToolModelOutput
} from './shared.ts'

// ---------------------------------------------------------------------------
// Patch format constants
// ---------------------------------------------------------------------------

const BEGIN_PATCH_MARKER = '*** Begin Patch'
const END_PATCH_MARKER = '*** End Patch'
const ADD_FILE_MARKER = '*** Add File: '
const DELETE_FILE_MARKER = '*** Delete File: '
const UPDATE_FILE_MARKER = '*** Update File: '
const MOVE_TO_MARKER = '*** Move to: '
const EOF_MARKER = '*** End of File'
const CHANGE_CONTEXT_MARKER = '@@ '
const EMPTY_CHANGE_CONTEXT_MARKER = '@@'

// ---------------------------------------------------------------------------
// Parser types
// ---------------------------------------------------------------------------

interface UpdateFileChunk {
  changeContext: string | undefined
  oldLines: string[]
  newLines: string[]
  isEndOfFile: boolean
}

export type Hunk =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; movePath: string | undefined; chunks: UpdateFileChunk[] }

interface ParsedPatch {
  hunks: Hunk[]
}

class ParseError extends Error {
  readonly lineNumber?: number

  constructor(message: string, lineNumber?: number) {
    super(lineNumber === undefined ? message : `line ${lineNumber}: ${message}`)
    this.name = 'ParseError'
    this.lineNumber = lineNumber
  }
}

type ParseMode = 'complete' | 'streaming'
export function parsePatch(patch: string): ParsedPatch {
  return parsePatchText(patch, 'complete')
}

export function parsePatchStreaming(patch: string): ParsedPatch {
  return parsePatchText(patch, 'streaming')
}

function parsePatchText(patch: string, mode: ParseMode): ParsedPatch {
  const trimmed = patch.trim()
  const lines = trimmed.split('\n')

  const [firstLine, lastLine] =
    lines.length === 0
      ? [undefined, undefined]
      : lines.length === 1
        ? [lines[0], lines[0]]
        : [lines[0], lines[lines.length - 1]]

  const first = firstLine?.trim()
  const last = lastLine?.trim()

  if (first !== BEGIN_PATCH_MARKER) {
    throw new ParseError("The first line of the patch must be '*** Begin Patch'", 1)
  }
  if (mode === 'complete' && last !== END_PATCH_MARKER) {
    throw new ParseError(`The last line of the patch must be '${END_PATCH_MARKER}'`, lines.length)
  }

  const hasEndMarker = last === END_PATCH_MARKER
  const hunkLines = lines.slice(1, hasEndMarker ? -1 : undefined)
  const hunks: Hunk[] = []
  let remaining = hunkLines
  let lineNumber = 2

  while (remaining.length > 0) {
    const [hunk, consumed] = parseOneHunk(remaining, lineNumber, mode === 'streaming')
    hunks.push(hunk)
    lineNumber += consumed
    remaining = remaining.slice(consumed)
  }

  return { hunks }
}

function parseOneHunk(
  lines: string[],
  lineNumber: number,
  allowIncomplete = false
): [Hunk, number] {
  const firstLine = lines[0].trim()

  if (firstLine.startsWith(ADD_FILE_MARKER)) {
    const path = firstLine.slice(ADD_FILE_MARKER.length)
    let contents = ''
    let parsed = 1
    for (const addLine of lines.slice(1)) {
      if (addLine.startsWith('+')) {
        contents += addLine.slice(1) + '\n'
        parsed += 1
      } else {
        break
      }
    }
    return [{ kind: 'add', path, contents }, parsed]
  }

  if (firstLine.startsWith(DELETE_FILE_MARKER)) {
    const path = firstLine.slice(DELETE_FILE_MARKER.length)
    return [{ kind: 'delete', path }, 1]
  }

  if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
    const path = firstLine.slice(UPDATE_FILE_MARKER.length)
    let rest = lines.slice(1)
    let parsed = 1

    let movePath: string | undefined
    if (rest.length > 0 && rest[0].trim().startsWith(MOVE_TO_MARKER)) {
      movePath = rest[0].trim().slice(MOVE_TO_MARKER.length).trim()
      rest = rest.slice(1)
      parsed += 1
    }

    const chunks: UpdateFileChunk[] = []
    while (rest.length > 0) {
      if (rest[0].trim().length === 0) {
        parsed += 1
        rest = rest.slice(1)
        continue
      }

      if (rest[0].trim().startsWith('*')) {
        break
      }

      const [chunk, chunkLines] = parseUpdateFileChunk(
        rest,
        lineNumber + parsed,
        chunks.length === 0
      )
      chunks.push(chunk)
      parsed += chunkLines
      rest = rest.slice(chunkLines)
    }

    if (chunks.length === 0) {
      if (allowIncomplete) {
        return [{ kind: 'update', path, movePath, chunks }, parsed]
      }
      throw new ParseError(`Update file hunk for path '${path}' is empty`, lineNumber)
    }

    return [{ kind: 'update', path, movePath, chunks }, parsed]
  }

  throw new ParseError(
    `'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    lineNumber
  )
}

function parseUpdateFileChunk(
  lines: string[],
  lineNumber: number,
  allowMissingContext: boolean
): [UpdateFileChunk, number] {
  if (lines.length === 0) {
    throw new ParseError('Update hunk does not contain any lines', lineNumber)
  }

  let changeContext: string | undefined
  let startIndex = 0

  const firstLine = lines[0].trim()

  if (firstLine === EMPTY_CHANGE_CONTEXT_MARKER) {
    changeContext = undefined
    startIndex = 1
  } else if (firstLine.startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = firstLine.slice(CHANGE_CONTEXT_MARKER.length).trim()
    startIndex = 1
  } else {
    if (!allowMissingContext) {
      throw new ParseError(
        `Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`,
        lineNumber
      )
    }
    changeContext = undefined
    startIndex = 0
  }

  if (startIndex >= lines.length) {
    throw new ParseError('Update hunk does not contain any lines', lineNumber)
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false
  }

  let parsed = 0
  for (const line of lines.slice(startIndex)) {
    if (line.trim() === EOF_MARKER) {
      if (parsed === 0) {
        throw new ParseError('Update hunk does not contain any lines', lineNumber)
      }
      chunk.isEndOfFile = true
      parsed += 1
      break
    }

    if (line.length === 0) {
      chunk.oldLines.push('')
      chunk.newLines.push('')
      parsed += 1
      continue
    }

    const firstChar = line[0]
    let consumed = false
    switch (firstChar) {
      case ' ':
        chunk.oldLines.push(line.slice(1))
        chunk.newLines.push(line.slice(1))
        consumed = true
        break
      case '+':
        chunk.newLines.push(line.slice(1))
        consumed = true
        break
      case '-':
        chunk.oldLines.push(line.slice(1))
        consumed = true
        break
      default:
        if (parsed === 0) {
          throw new ParseError(
            `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
            lineNumber + startIndex + parsed
          )
        }
        // Start of next hunk
        break
    }

    if (!consumed) {
      break
    }
    parsed += 1
  }

  return [chunk, parsed + startIndex]
}

// ---------------------------------------------------------------------------
// Seek sequence (fuzzy line matching)
// ---------------------------------------------------------------------------

export function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean
): number | undefined {
  if (pattern.length === 0) {
    return start
  }
  if (pattern.length > lines.length) {
    return undefined
  }

  const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start

  // Exact match
  outer: for (let i = searchStart; i <= lines.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j] !== pattern[j]) continue outer
    }
    return i
  }

  // Rstrip match
  outer: for (let i = searchStart; i <= lines.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j].trimEnd() !== pattern[j].trimEnd()) continue outer
    }
    return i
  }

  // Trim match
  outer: for (let i = searchStart; i <= lines.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j].trim() !== pattern[j].trim()) continue outer
    }
    return i
  }

  // Unicode normalization match
  function normalize(s: string): string {
    return s
      .trim()
      .split('')
      .map((c) => {
        switch (c) {
          case '\u2010':
          case '\u2011':
          case '\u2012':
          case '\u2013':
          case '\u2014':
          case '\u2015':
          case '\u2212':
            return '-'
          case '\u2018':
          case '\u2019':
          case '\u201A':
          case '\u201B':
            return "'"
          case '\u201C':
          case '\u201D':
          case '\u201E':
          case '\u201F':
            return '"'
          case '\u00A0':
          case '\u2002':
          case '\u2003':
          case '\u2004':
          case '\u2005':
          case '\u2006':
          case '\u2007':
          case '\u2008':
          case '\u2009':
          case '\u200A':
          case '\u202F':
          case '\u205F':
          case '\u3000':
            return ' '
          default:
            return c
        }
      })
      .join('')
  }

  outer: for (let i = searchStart; i <= lines.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (normalize(lines[i + j]) !== normalize(pattern[j])) continue outer
    }
    return i
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Replacement logic
// ---------------------------------------------------------------------------

interface Replacement {
  start: number
  oldLen: number
  newLines: string[]
}

function computeReplacements(
  originalLines: string[],
  chunks: UpdateFileChunk[],
  filePath = 'target file'
): Replacement[] {
  const replacements: Replacement[] = []
  let lineIndex = 0

  for (const chunk of chunks) {
    let foundContext: { text: string; line: number } | undefined
    if (chunk.changeContext !== undefined) {
      const idx = seekSequence(originalLines, [chunk.changeContext], lineIndex, false)
      if (idx === undefined) {
        throw new Error(`Failed to find anchor '${chunk.changeContext}' in ${filePath}`)
      }
      foundContext = { text: chunk.changeContext, line: idx + 1 }
      lineIndex = idx + 1
    }

    if (chunk.oldLines.length === 0) {
      const insertionIdx = foundContext
        ? lineIndex
        : originalLines.length > 0 && originalLines[originalLines.length - 1] === ''
          ? originalLines.length - 1
          : originalLines.length
      replacements.push({ start: insertionIdx, oldLen: 0, newLines: chunk.newLines })
      lineIndex = insertionIdx + chunk.newLines.length
      continue
    }

    let pattern = chunk.oldLines
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)
    let newSlice = chunk.newLines

    if (found === undefined && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1)
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1)
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)
    }

    if (found === undefined) {
      const expected = chunk.oldLines.join('\n')
      if (foundContext) {
        throw new Error(
          `Found anchor '${foundContext.text}' in ${filePath} at line ${foundContext.line}, but could not find expected lines after it:\n${expected}`
        )
      }
      throw new Error(`Failed to find expected lines in ${filePath}:\n${expected}`)
    }

    replacements.push({ start: found, oldLen: pattern.length, newLines: newSlice })
    lineIndex = found + pattern.length
  }

  replacements.sort((a, b) => a.start - b.start)
  return replacements
}

function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
  const result = [...lines]
  for (const { start, oldLen, newLines } of replacements.sort((a, b) => b.start - a.start)) {
    result.splice(start, oldLen, ...newLines)
  }
  return result
}

// ---------------------------------------------------------------------------
// Diff generation
// ---------------------------------------------------------------------------

function generateUnifiedDiff(filePath: string, original: string, updated: string): string {
  try {
    return createTwoFilesPatch(filePath, filePath, original, updated, undefined, undefined, {
      context: 2
    })
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

function isPathInsideWorkspace(workspacePath: string, resolvedPath: string): boolean {
  const rel = relative(workspacePath, resolvedPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isInputEffectivelyAbsolute(rawPath: string): boolean {
  const unquoted = rawPath.trim().replace(/^(['"`])(.*)\1$/, '$2')
  return isAbsolute(unquoted) || unquoted.startsWith('~')
}

async function resolveExistingPathForBoundary(resolvedPath: string): Promise<string | undefined> {
  let candidate = resolvedPath
  while (true) {
    try {
      return await realpath(candidate)
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? err.code : undefined
      if (code !== 'ENOENT') return undefined
      const parent = dirname(candidate)
      if (parent === candidate) return undefined
      candidate = parent
    }
  }
}

async function validateRelativePathBoundary(input: {
  workspacePath: string
  rawPath: string
  resolvedPath: string
  pathLabel: string
}): Promise<string | undefined> {
  if (!isPathInsideWorkspace(input.workspacePath, input.resolvedPath)) {
    return `Relative ${input.pathLabel} \`${input.rawPath}\` escapes the workspace. applyPatch only supports relative paths inside ${input.workspacePath}.`
  }

  const realWorkspace = await realpath(input.workspacePath)
  const realExistingPath = await resolveExistingPathForBoundary(input.resolvedPath)
  if (realExistingPath && !isPathInsideWorkspace(realWorkspace, realExistingPath)) {
    return `Relative ${input.pathLabel} \`${input.rawPath}\` resolves outside the workspace via a symlink. applyPatch only supports relative paths inside ${input.workspacePath}.`
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

function createResult(details: ApplyPatchToolCallDetails, error?: string): ApplyPatchToolOutput {
  const opCount = details.operations.length
  let message: string
  if (error) {
    message = error
  } else if (opCount === 0) {
    message = 'No changes were made.'
  } else {
    const parts = details.operations.map((op) => {
      switch (op.operation) {
        case 'add':
          return `Added ${op.path}`
        case 'delete':
          return `Deleted ${op.path}`
        case 'move':
          return `Moved ${op.path} → ${op.movePath}`
        case 'update':
          return `Updated ${op.path}`
        default:
          return `Modified ${op.path}`
      }
    })
    message = `Applied ${opCount} change${opCount === 1 ? '' : 's'}:\n${parts.join('\n')}`
  }

  return {
    content: textContent(message),
    details,
    ...(error ? { error } : {}),
    metadata: {}
  }
}

// ---------------------------------------------------------------------------
// Atomic apply planning
// ---------------------------------------------------------------------------

interface PlannedWrite {
  kind: 'write'
  path: string
  content: string
}

interface PlannedDelete {
  kind: 'delete'
  path: string
}

type PlannedFileChange = PlannedWrite | PlannedDelete

interface VirtualFileState {
  exists: boolean
  isFile: boolean
  content: string
}

async function readFileState(path: string, abortSignal?: AbortSignal): Promise<VirtualFileState> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { exists: true, isFile: false, content: '' }
    const content = await readFile(path, { encoding: 'utf8', signal: abortSignal })
    return { exists: true, isFile: true, content }
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') return { exists: false, isFile: false, content: '' }
    throw err
  }
}

function splitPatchLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

async function applyPlannedFileChanges(
  changes: PlannedFileChange[],
  originalStates: Map<string, VirtualFileState>
): Promise<void> {
  const applied: PlannedFileChange[] = []
  try {
    for (const change of changes) {
      if (change.kind === 'write') {
        await mkdir(dirname(change.path), { recursive: true })
        await writeFile(change.path, change.content, { encoding: 'utf8' })
      } else {
        await unlink(change.path)
      }
      applied.push(change)
    }
  } catch (err) {
    for (const change of applied.reverse()) {
      const original = originalStates.get(change.path)
      if (!original) continue
      try {
        if (original.exists) {
          await mkdir(dirname(change.path), { recursive: true })
          await writeFile(change.path, original.content, { encoding: 'utf8' })
        } else {
          await unlink(change.path)
        }
      } catch {
        // Best-effort rollback; the original error is more useful to report.
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export function createTool(
  context: AgentToolContext
): Tool<ApplyPatchToolInput, ApplyPatchToolOutput> {
  return tool({
    description: `Apply a patch to create, update, move, or delete files inside the workspace only. Changes are located by searching for text in the file, not by line numbers.

The patch starts with '*** Begin Patch' and ends with '*** End Patch'. Multiple file operations can be included.

Format:
*** Add File: path
+line
+line
*** Delete File: path
*** Update File: path
*** Move to: newPath        (optional)
@@ anchor text             (optional on first hunk, required after)
 context line
-removed line
+added line
@@ next anchor
 ...
*** End of File
*** End Patch

Rules:
- Update hunks locate changes by searching for context lines and removed lines.
- The first update hunk may omit @@ and starts searching from the top. Every later hunk must begin with @@ <unique anchor text>.
- Lines starting with ' ' are context (must exist exactly). '-' removes. '+' adds.
- *** End of File placed at the end of a hunk forces that hunk to match at the end of the file.
- Paths must be relative and stay inside ${context.workspacePath}.`,
    inputSchema: applyPatchToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) => runApplyPatchTool(input, context, options)
  })
}

export async function runApplyPatchTool(
  input: ApplyPatchToolInput,
  context: AgentToolContext,
  options: { abortSignal?: AbortSignal } = {}
): Promise<ApplyPatchToolOutput> {
  let parsed: ParsedPatch
  try {
    parsed = parsePatch(input.patch)
  } catch (err) {
    const message = err instanceof ParseError ? err.message : 'Invalid patch format.'
    return createResult({ operations: [] }, message)
  }

  if (parsed.hunks.length === 0) {
    return createResult({ operations: [] }, 'No hunks found in patch.')
  }

  const details: ApplyPatchToolCallDetails = { operations: [] }
  const originalStates = new Map<string, VirtualFileState>()
  const virtualStates = new Map<string, VirtualFileState>()

  async function getState(path: string): Promise<VirtualFileState> {
    const virtual = virtualStates.get(path)
    if (virtual) return virtual
    const state = await readFileState(path, options.abortSignal)
    originalStates.set(path, state)
    virtualStates.set(path, state)
    return state
  }

  function setState(path: string, state: VirtualFileState): void {
    virtualStates.set(path, state)
  }

  try {
    for (const hunk of parsed.hunks) {
      const sourcePath = hunk.path
      const resolvedSourcePath = await resolveUnicodeSpacePath(
        resolveToolPath(context.workspacePath, sourcePath)
      )

      if (isInputEffectivelyAbsolute(sourcePath)) {
        return createResult(
          { operations: [] },
          `applyPatch only supports relative paths inside the workspace. Requested: ${sourcePath}`
        )
      }
      const boundaryError = await validateRelativePathBoundary({
        workspacePath: context.workspacePath,
        rawPath: sourcePath,
        resolvedPath: resolvedSourcePath,
        pathLabel: 'path'
      })
      if (boundaryError) return createResult({ operations: [] }, boundaryError)

      if (hunk.kind === 'update' && hunk.movePath) {
        const destPath = await resolveUnicodeSpacePath(
          resolveToolPath(context.workspacePath, hunk.movePath)
        )
        if (isInputEffectivelyAbsolute(hunk.movePath)) {
          return createResult(
            { operations: [] },
            `applyPatch only supports relative move destinations inside the workspace. Requested: ${hunk.movePath}`
          )
        }
        const boundaryError = await validateRelativePathBoundary({
          workspacePath: context.workspacePath,
          rawPath: hunk.movePath,
          resolvedPath: destPath,
          pathLabel: 'move destination'
        })
        if (boundaryError) return createResult({ operations: [] }, boundaryError)
      }

      switch (hunk.kind) {
        case 'add': {
          const target = await getState(resolvedSourcePath)
          if (target.exists) {
            throw new Error(`Add target already exists: ${hunk.path}`)
          }
          setState(resolvedSourcePath, { exists: true, isFile: true, content: hunk.contents })
          details.operations.push({ path: hunk.path, operation: 'add' })
          break
        }

        case 'delete': {
          const target = await getState(resolvedSourcePath)
          if (!target.exists) throw new Error(`Delete target does not exist: ${hunk.path}`)
          if (!target.isFile) throw new Error(`\`${resolvedSourcePath}\` is not a regular file.`)
          setState(resolvedSourcePath, { exists: false, isFile: false, content: '' })
          details.operations.push({ path: hunk.path, operation: 'delete' })
          break
        }

        case 'update': {
          const source = await getState(resolvedSourcePath)
          if (!source.exists) throw new Error(`Update target does not exist: ${hunk.path}`)
          if (!source.isFile) throw new Error(`\`${resolvedSourcePath}\` is not a regular file.`)

          const hadTrailingNewline = source.content.endsWith('\n')
          const originalLines = splitPatchLines(source.content)
          const replacements = computeReplacements(originalLines, hunk.chunks, hunk.path)
          const newLines = applyReplacements(originalLines, replacements)
          if (
            hadTrailingNewline &&
            !(newLines.length > 0 && newLines[newLines.length - 1] === '')
          ) {
            newLines.push('')
          }
          const newContent = newLines.join('\n')
          const diff = generateUnifiedDiff(hunk.path, source.content, newContent)

          if (hunk.movePath) {
            const destPath = await resolveUnicodeSpacePath(
              resolveToolPath(context.workspacePath, hunk.movePath)
            )
            const dest = await getState(destPath)
            if (dest.exists && destPath !== resolvedSourcePath) {
              throw new Error(`Move destination already exists: ${hunk.movePath}`)
            }
            setState(resolvedSourcePath, { exists: false, isFile: false, content: '' })
            setState(destPath, { exists: true, isFile: true, content: newContent })
            details.operations.push({
              path: hunk.path,
              operation: 'move',
              movePath: hunk.movePath,
              diff
            })
          } else {
            setState(resolvedSourcePath, { exists: true, isFile: true, content: newContent })
            details.operations.push({ path: hunk.path, operation: 'update', diff })
          }
          break
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return createResult({ operations: [] }, `Failed to apply patch: ${message}`)
  }

  const changes: PlannedFileChange[] = []
  for (const [path, finalState] of virtualStates) {
    const originalState = originalStates.get(path)
    if (!originalState) continue
    if (finalState.exists) {
      if (!originalState.exists || originalState.content !== finalState.content) {
        changes.push({ kind: 'write', path, content: finalState.content })
      }
    } else if (originalState.exists) {
      changes.push({ kind: 'delete', path })
    }
  }

  try {
    if (context.snapshotTracker) {
      for (const change of changes) {
        await context.snapshotTracker.trackBeforeWrite(change.path)
      }
    }
    await applyPlannedFileChanges(changes, originalStates)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return createResult({ operations: [] }, `Failed to apply patch: ${message}`)
  }

  return createResult(details)
}
