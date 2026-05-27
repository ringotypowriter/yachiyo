import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface BashReadRange {
  resolvedPath: string
  startLine: number
  endLine: number
}

/**
 * Best-effort extraction of file reads from bash commands that are clearly
 * read-only. Returns an empty array for anything ambiguous or write-capable.
 *
 * Supported patterns:
 *   sed -n 'X,Yp' file          → lines X–Y
 *   sed -n 'Xp' file            → line X
 *   sed -n 'X,+Np' file         → lines X–(X+N)
 *   sed -n 'X,$p' file          → lines X–EOF
 *   head [-n N] file            → lines 1–N (default 10)
 *   tail [-n N] file            → lines (EOF-N+1)–EOF (default 10)
 *   cat file …                  → lines 1–EOF
 *   less / more / bat / nl file → lines 1–EOF
 */
export async function extractBashReadRanges(
  command: string,
  cwd: string
): Promise<BashReadRange[]> {
  // Reject pipelines — we cannot trace what the model actually saw.
  if (command.includes('|')) {
    return []
  }

  // Reject command chains — we cannot know which segments actually ran
  // (short-circuit evaluation, exit-code branching, etc.).
  if (/;|&&|\|\|/.test(command)) {
    return []
  }

  // Reject output redirects — these write.
  if (/(?:^|[^>])\s*>>?\s*\S/.test(command)) {
    return []
  }

  return extractFromSegment(command.trim(), cwd)
}

async function extractFromSegment(command: string, cwd: string): Promise<BashReadRange[]> {
  const tokens = tokenize(command)
  if (tokens.length === 0) return []

  const cmd = tokens[0]!.toLowerCase()

  switch (cmd) {
    case 'sed':
      return extractSedReads(tokens, cwd)
    case 'head':
      return extractHeadReads(tokens, cwd)
    case 'tail':
      return extractTailReads(tokens, cwd)
    case 'cat':
    case 'less':
    case 'more':
    case 'bat':
    case 'nl':
      return extractViewerReads(tokens, cwd)
    default:
      return []
  }
}

/* ------------------------------------------------------------------ */
// Tokenizer (respects single and double quotes)

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false

  for (const ch of command) {
    if (ch === "'" && !inDouble) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      inDouble = !inDouble
      continue
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/* ------------------------------------------------------------------ */
// sed

async function extractSedReads(tokens: string[], cwd: string): Promise<BashReadRange[]> {
  let hasN = false
  let hasI = false
  const scripts: string[] = []
  const nonFlags: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '-n' || t === '--quiet' || t === '--silent') {
      hasN = true
      continue
    }
    if (t === '-i' || t.startsWith('-i')) {
      hasI = true
      continue
    }
    if (t === '-e' && i + 1 < tokens.length) {
      scripts.push(tokens[i + 1]!)
      i++
      continue
    }
    if (t.startsWith('-')) {
      // Other flags that take arguments (e.g. -f script-file)
      if ((t === '-f' || t === '--file') && i + 1 < tokens.length) {
        i++
      }
      continue
    }
    nonFlags.push(t)
  }

  if (hasI || !hasN) return []
  if (scripts.length > 1) return [] // non-contiguous / too complex

  let script: string | undefined
  let files: string[]

  if (scripts.length === 0) {
    if (nonFlags.length === 0) return []
    script = nonFlags[0]!
    files = nonFlags.slice(1)
  } else {
    script = scripts[0]!
    files = nonFlags
  }

  if (files.length === 0) return []

  // Only handle simple numeric print ranges.
  const rangeMatch = /^(\d+)(?:,(\d+)|,\+(\d+)|,\$)?p$/.exec(script)
  if (!rangeMatch) return []

  const start = parseInt(rangeMatch[1]!, 10)
  let end: number

  if (rangeMatch[2]) {
    end = parseInt(rangeMatch[2]!, 10)
  } else if (rangeMatch[3]) {
    end = start + parseInt(rangeMatch[3]!, 10)
  } else if (script.includes(',$')) {
    const total = await countLines(resolve(cwd, files[0]!))
    end = total
  } else {
    end = start
  }

  const cappedEnd = Math.min(end, await countLines(resolve(cwd, files[0]!)))
  if (start > cappedEnd) return []

  return files.map((f) => ({
    resolvedPath: resolve(cwd, f),
    startLine: start,
    endLine: cappedEnd
  }))
}

/* ------------------------------------------------------------------ */
// head

async function extractHeadReads(tokens: string[], cwd: string): Promise<BashReadRange[]> {
  let count = 10 // default
  const files: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '-n' && i + 1 < tokens.length) {
      const n = parseInt(tokens[i + 1]!, 10)
      if (!Number.isNaN(n)) count = n
      i++
      continue
    }
    if (/^-\d+$/.test(t)) {
      count = parseInt(t.slice(1), 10)
      continue
    }
    if (t.startsWith('-')) {
      // Reject byte-count mode — the model only sees bytes, not lines.
      if (t === '-c') {
        return []
      }
      continue
    }
    files.push(t)
  }

  const ranges: BashReadRange[] = []
  for (const f of files) {
    const total = await countLines(resolve(cwd, f))
    ranges.push({
      resolvedPath: resolve(cwd, f),
      startLine: 1,
      endLine: Math.min(count, total)
    })
  }
  return ranges
}

/* ------------------------------------------------------------------ */
// tail

async function extractTailReads(tokens: string[], cwd: string): Promise<BashReadRange[]> {
  let count = 10 // default
  const files: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '-n' && i + 1 < tokens.length) {
      const n = parseInt(tokens[i + 1]!, 10)
      if (!Number.isNaN(n)) count = n
      i++
      continue
    }
    if (/^-\d+$/.test(t)) {
      count = parseInt(t.slice(1), 10)
      continue
    }
    if (t.startsWith('-')) {
      // Reject byte-count mode — the model only sees bytes, not lines.
      if (t === '-c') {
        return []
      }
      continue
    }
    files.push(t)
  }

  const ranges: BashReadRange[] = []
  for (const f of files) {
    const total = await countLines(resolve(cwd, f))
    const startLine = Math.max(1, total - count + 1)
    ranges.push({
      resolvedPath: resolve(cwd, f),
      startLine,
      endLine: total
    })
  }
  return ranges
}

/* ------------------------------------------------------------------ */
// cat / less / more / bat / nl

async function extractViewerReads(tokens: string[], cwd: string): Promise<BashReadRange[]> {
  const files: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.startsWith('-')) continue
    files.push(t)
  }

  const ranges: BashReadRange[] = []
  for (const f of files) {
    const total = await countLines(resolve(cwd, f))
    ranges.push({
      resolvedPath: resolve(cwd, f),
      startLine: 1,
      endLine: total
    })
  }
  return ranges
}

/* ------------------------------------------------------------------ */
// Helpers

async function countLines(path: string): Promise<number> {
  try {
    const content = await readFile(path, 'utf8')
    if (content.length === 0) return 0
    return content.split(/\r?\n/).length
  } catch {
    return 0
  }
}
