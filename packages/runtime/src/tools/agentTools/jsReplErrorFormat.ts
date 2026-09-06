import type { JsReplSourceOrigin } from './jsReplCellCompiler.ts'

export const JS_REPL_SCRIPT_FILENAME = 'jsRepl'

const CODE_FRAME_CONTEXT_LINES = 2
const MAX_CODE_FRAME_LINE_CHARS = 200
const MAX_FRAMES = 12

// "    at name (jsRepl:12:5)" and the anonymous "    at jsRepl:12:5".
const CELL_FRAME = new RegExp(
  String.raw`^\s*at\s+(?:(.*?)\s+\()?${JS_REPL_SCRIPT_FILENAME}:(\d+):(\d+)\)?$`
)

export interface JsReplErrorContext {
  /** The cell exactly as the model wrote it. */
  code: string
  /** Compiled-line origins from `compileJsReplCell`, absent when compilation failed. */
  sourceOrigins?: readonly (JsReplSourceOrigin | undefined)[]
}

interface CellLocation {
  line: number
  column: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Babel reports syntax errors against the author's cell directly, so its
 * location needs no remapping — only its parser stack has to go.
 */
function syntaxErrorLocation(error: unknown): CellLocation | undefined {
  if (!isRecord(error) || error.code !== 'BABEL_PARSER_SYNTAX_ERROR') return undefined
  const loc = error.loc
  if (!isRecord(loc) || typeof loc.line !== 'number' || typeof loc.column !== 'number') {
    return undefined
  }
  return { line: loc.line, column: loc.column + 1 }
}

function errorHeader(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || 'Error'
    return error.message ? `${name}: ${error.message}` : name
  }
  if (isRecord(error) && typeof error.message === 'string') {
    const name = typeof error.name === 'string' ? error.name : 'Error'
    return `${name}: ${error.message}`
  }
  return String(error)
}

function stackOf(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.stack === 'string') return error.stack
  return undefined
}

function mapFrames(
  error: unknown,
  sourceOrigins: readonly (JsReplSourceOrigin | undefined)[] | undefined
): { frames: string[]; top: CellLocation | undefined } {
  const stack = stackOf(error)
  if (!stack || !sourceOrigins) return { frames: [], top: undefined }

  const frames: string[] = []
  let top: CellLocation | undefined
  for (const line of stack.split('\n')) {
    const match = CELL_FRAME.exec(line)
    if (!match) continue
    const origin = sourceOrigins[Number(match[2]) - 1]
    // Frames inside the generated wrapper have no author line; drop them rather
    // than point the model at code it never wrote.
    if (!origin) continue
    const location = {
      line: origin.line,
      column: Math.max(1, Number(match[3]) - origin.columnDelta)
    }
    top ??= location
    const label = match[1] ? `${match[1]} (` : ''
    const close = match[1] ? ')' : ''
    frames.push(
      `    at ${label}${JS_REPL_SCRIPT_FILENAME}:${location.line}:${location.column}${close}`
    )
    if (frames.length >= MAX_FRAMES) break
  }
  return { frames, top }
}

function codeFrame(code: string, location: CellLocation): string[] {
  const lines = code.split('\n')
  if (location.line < 1 || location.line > lines.length) return []

  const first = Math.max(1, location.line - CODE_FRAME_CONTEXT_LINES)
  const last = Math.min(lines.length, location.line + CODE_FRAME_CONTEXT_LINES)
  const gutter = String(last).length
  const rendered: string[] = []
  for (let line = first; line <= last; line += 1) {
    const text = lines[line - 1]!.slice(0, MAX_CODE_FRAME_LINE_CHARS)
    const marker = line === location.line ? '>' : ' '
    rendered.push(`${marker} ${String(line).padStart(gutter)} | ${text}`)
    if (line === location.line && location.column <= text.length + 1) {
      rendered.push(`  ${' '.repeat(gutter)} | ${' '.repeat(location.column - 1)}^`)
    }
  }
  return rendered
}

/**
 * Render a cell failure for the model: the message, frames rewritten to the
 * author's own line numbers, and the offending source line. Frames from the vm
 * wrapper, the worker, and the packaged runtime are dropped — they describe our
 * plumbing, not the cell, and reading them sends the model chasing our internals.
 */
export function formatJsReplError(error: unknown, context: JsReplErrorContext): string {
  const syntaxLocation = syntaxErrorLocation(error)
  if (syntaxLocation) {
    return [errorHeader(error), '', ...codeFrame(context.code, syntaxLocation)].join('\n').trimEnd()
  }

  let { frames, top } = mapFrames(error, context.sourceOrigins)
  if (frames.length === 0 && error instanceof Error && error.cause !== undefined) {
    // The worker rethrows unhandled async failures through a wrapper whose own
    // stack is worker-only; the cell frames live on the cause.
    ;({ frames, top } = mapFrames(error.cause, context.sourceOrigins))
  }

  const parts = [errorHeader(error), ...frames]
  if (top) parts.push('', ...codeFrame(context.code, top))
  return parts.join('\n').trimEnd()
}

/**
 * Collapse a schema validation failure into the fields that are actually wrong.
 * Zod stringifies its whole issue array into `message`, which buries the one
 * line the model needs under JSON it cannot act on.
 */
export function formatToolInputValidationError(toolName: string, error: unknown): string {
  const issues = isRecord(error) && Array.isArray(error.issues) ? error.issues : undefined
  const summary = issues
    ?.filter(isRecord)
    .map((issue) => {
      const path = Array.isArray(issue.path) ? issue.path.join('.') : ''
      const message = typeof issue.message === 'string' ? issue.message : 'invalid value'
      return path ? `${path}: ${message}` : message
    })
    .join('; ')

  return `Invalid input for tool ${JSON.stringify(toolName)}: ${
    summary && summary.length > 0 ? summary : errorHeader(error)
  }`
}
