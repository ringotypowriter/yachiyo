/**
 * Bash command security validation system.
 *
 * Validates shell commands before execution to detect injection attacks
 * via misparsing differentials (control characters, carriage returns,
 * quote desync, etc.) that could allow an attacker to execute arbitrary
 * commands by exploiting how our validators parse commands differently
 * from how the shell actually executes them.
 *
 * Design: only **misparsing-class** threats are blocked. The reference
 * implementation's "ask" category (suspicious but not misparsing) is
 * auto-accepted since the backend handles user approval externally.
 *
 * The main entry point is {@link validateBashCommand}.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecurityResult {
  /** Whether the command should be blocked from execution. */
  blocked: boolean
  /** Human-readable reason (populated when blocked). */
  message: string
}

interface ValidationContext {
  originalCommand: string
  baseCommand: string
  /** Single-quoted content stripped; double-quoted content preserved. */
  unquotedContent: string
  /** Both single- and double-quoted content stripped. */
  fullyUnquotedContent: string
  /** fullyUnquoted BEFORE stripping safe redirections. */
  fullyUnquotedPreStrip: string
  /** Like fullyUnquotedPreStrip but preserves quote characters ('/""). */
  unquotedKeepQuoteChars: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHELL_OPERATORS = new Set([';', '|', '&', '<', '>'])

/** Non-printable control characters (excludes tab, LF, CR handled elsewhere). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/** Unicode whitespace that JS \s matches but bash IFS doesn't. */

const UNICODE_WS_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ok: SecurityResult = { blocked: false, message: '' }
const refused = (message: string): SecurityResult => ({ blocked: true, message })

interface QuoteExtraction {
  withDoubleQuotes: string
  fullyUnquoted: string
  unquotedKeepQuoteChars: string
}

function extractQuotedContent(command: string, isJq = false): QuoteExtraction {
  let withDoubleQuotes = ''
  let fullyUnquoted = ''
  let unquotedKeepQuoteChars = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (escaped) {
      escaped = false
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      unquotedKeepQuoteChars += char
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      unquotedKeepQuoteChars += char
      if (!isJq) continue
    }

    if (!inSingleQuote) withDoubleQuotes += char
    if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
    if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
}

function stripSafeRedirections(content: string): string {
  // SECURITY: All patterns MUST have a trailing boundary (?=\s|$).
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, '')
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, '')
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, '')
}

function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashCount = 0
  let i = pos - 1
  while (i >= 0 && content[i] === '\\') {
    backslashCount++
    i--
  }
  return backslashCount % 2 === 1
}

function buildContext(command: string): ValidationContext {
  const baseCommand = command.trim().split(/\s+/)[0] || ''
  const { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars } = extractQuotedContent(
    command,
    baseCommand === 'jq'
  )

  return {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars
  }
}

// ---------------------------------------------------------------------------
// Misparsing-class validators (hard block)
// ---------------------------------------------------------------------------
// These detect patterns where our regex-based analysis would parse the command
// differently from how bash actually executes it, creating security holes.

/** Block non-printable control chars that bash silently drops but our regex sees. */
function validateControlCharacters(ctx: ValidationContext): SecurityResult {
  if (CONTROL_CHAR_RE.test(ctx.originalCommand)) {
    return refused(
      'Command contains non-printable control characters that could bypass security checks.'
    )
  }
  return ok
}

/**
 * Block carriage return outside double quotes.
 * CR is in JS \s but NOT in bash IFS — tokenization differential.
 */
function validateCarriageReturn(ctx: ValidationContext): SecurityResult {
  const { originalCommand } = ctx
  if (!originalCommand.includes('\r')) return ok

  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const c = originalCommand[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (c === '\r' && !inDoubleQuote) {
      return refused(
        'Command contains carriage return (\\r) outside double quotes — shell tokenization differential.'
      )
    }
  }

  return ok
}

/** Block Unicode whitespace that JS \s matches but bash treats as literal. */
function validateUnicodeWhitespace(ctx: ValidationContext): SecurityResult {
  if (UNICODE_WS_RE.test(ctx.originalCommand)) {
    return refused(
      'Command contains Unicode whitespace characters that could cause parsing inconsistencies.'
    )
  }
  return ok
}

/**
 * Block backslash-escaped whitespace outside quotes.
 * `echo\ test` is one token in bash but two in shell-quote → path traversal.
 */
function validateBackslashEscapedWhitespace(ctx: ValidationContext): SecurityResult {
  const command = ctx.originalCommand
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar === ' ' || nextChar === '\t') {
          return refused(
            'Command contains backslash-escaped whitespace that could alter command parsing.'
          )
        }
      }
      i++
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
  }

  return ok
}

/**
 * Block backslash before shell operator outside quotes.
 * splitCommand normalizes `\;` to bare `;` → double-parse enables read bypass.
 */
function validateBackslashEscapedOperators(ctx: ValidationContext): SecurityResult {
  const command = ctx.originalCommand
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar && SHELL_OPERATORS.has(nextChar)) {
          return refused(
            'Command contains a backslash before a shell operator (;, |, &, <, >) which can hide command structure.'
          )
        }
      }
      i++
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
  }

  return ok
}

/**
 * Block mid-word # — shell-quote treats it as comment start but bash treats
 * it as literal, creating a parser differential.
 */
function validateMidWordHash(ctx: ValidationContext): SecurityResult {
  const { unquotedKeepQuoteChars } = ctx

  const joined = unquotedKeepQuoteChars.replace(/\\+\n/g, (match) => {
    const backslashCount = match.length - 1
    return backslashCount % 2 === 1 ? '\\'.repeat(backslashCount - 1) : match
  })

  // Exclude ${# which is bash string-length syntax
  if (/\S(?<!\$\{)#/.test(unquotedKeepQuoteChars) || /\S(?<!\$\{)#/.test(joined)) {
    return refused(
      'Command contains mid-word # which is parsed differently by different shell parsers.'
    )
  }

  return ok
}

/**
 * Block quote characters inside # comments — desync downstream quote trackers.
 */
function validateCommentQuoteDesync(ctx: ValidationContext): SecurityResult {
  const { originalCommand } = ctx
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]!

    if (escaped) {
      escaped = false
      continue
    }

    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (inDoubleQuote) {
      if (char === '"') inDoubleQuote = false
      continue
    }

    if (char === "'") {
      inSingleQuote = true
      continue
    }

    if (char === '"') {
      inDoubleQuote = true
      continue
    }

    if (char === '#') {
      const lineEnd = originalCommand.indexOf('\n', i)
      const commentText = originalCommand.slice(
        i + 1,
        lineEnd === -1 ? originalCommand.length : lineEnd
      )
      if (/['"]/.test(commentText)) {
        return refused(
          'Command contains quote characters inside a # comment which can desync quote tracking.'
        )
      }
      if (lineEnd === -1) break
      i = lineEnd
    }
  }

  return ok
}

/**
 * Block quoted newline + #-prefixed line — stripCommentLines drops content
 * that is actually inside a quoted argument, hiding paths from validation.
 */
function validateQuotedNewline(ctx: ValidationContext): SecurityResult {
  const { originalCommand } = ctx

  if (!originalCommand.includes('\n') || !originalCommand.includes('#')) return ok

  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]!

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === '\n' && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1
      const nextNewline = originalCommand.indexOf('\n', lineStart)
      const lineEnd = nextNewline === -1 ? originalCommand.length : nextNewline
      const nextLine = originalCommand.slice(lineStart, lineEnd)
      if (nextLine.trim().startsWith('#')) {
        return refused(
          'Command contains a quoted newline followed by a #-prefixed line, which can hide arguments from permission checks.'
        )
      }
    }
  }

  return ok
}

/**
 * Block brace expansion that could alter command parsing.
 * Bash expands `{a,b}` and `{1..5}` but regex parsers treat them as literal.
 */
function validateBraceExpansion(ctx: ValidationContext): SecurityResult {
  const content = ctx.fullyUnquotedPreStrip

  let unescapedOpenBraces = 0
  let unescapedCloseBraces = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{' && !isEscapedAtPosition(content, i)) unescapedOpenBraces++
    else if (content[i] === '}' && !isEscapedAtPosition(content, i)) unescapedCloseBraces++
  }

  // Excess } means a quoted { was stripped → depth matching is unreliable
  if (unescapedOpenBraces > 0 && unescapedCloseBraces > unescapedOpenBraces) {
    return refused(
      'Command has excess closing braces after quote stripping (possible brace expansion obfuscation).'
    )
  }

  // Quoted brace inside an unquoted brace context
  if (unescapedOpenBraces > 0 && /['"][{}]['"]/.test(ctx.originalCommand)) {
    return refused(
      'Command contains quoted brace character inside brace context (potential obfuscation).'
    )
  }

  // Scan for actual brace expansion: {a,b} or {1..5}
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue
    if (isEscapedAtPosition(content, i)) continue

    let depth = 1
    let matchingClose = -1
    for (let j = i + 1; j < content.length; j++) {
      const ch = content[j]!
      if (ch === '{' && !isEscapedAtPosition(content, j)) depth++
      else if (ch === '}' && !isEscapedAtPosition(content, j)) {
        depth--
        if (depth === 0) {
          matchingClose = j
          break
        }
      }
    }

    if (matchingClose === -1) continue

    let innerDepth = 0
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = content[k]!
      if (ch === '{' && !isEscapedAtPosition(content, k)) innerDepth++
      else if (ch === '}' && !isEscapedAtPosition(content, k)) innerDepth--
      else if (innerDepth === 0) {
        if (ch === ',' || (ch === '.' && k + 1 < matchingClose && content[k + 1] === '.')) {
          return refused('Command contains brace expansion that could alter command parsing.')
        }
      }
    }
  }

  return ok
}

// ---------------------------------------------------------------------------
// Catastrophic command detection (kept from original bashTool.ts)
// ---------------------------------------------------------------------------

/**
 * Detect obviously catastrophic destructive commands like `rm /` or
 * `rm -rf /System`. These are always blocked regardless of context.
 */
export function isBlockedBashCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (!/(^|[;&|])\s*(sudo\s+)?(\/bin\/)?rm\b/.test(normalized)) {
    return false
  }

  return /(^|[;&|])\s*(sudo\s+)?(\/bin\/)?rm\b(?:\s+-[-\w]+|\s+--)*\s+(?:\/(?:\s|$)|\/[*](?:\s|$)|\/(?:System|Library|Applications|usr|bin|sbin|etc|var|opt)(?:\/|\s|$))/.test(
    normalized
  )
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Validate a bash command for security issues.
 *
 * Returns a {@link SecurityResult}. When `blocked` is true, the command
 * must NOT be executed — the `message` explains why.
 *
 * Only misparsing-class threats (where our validator would parse the command
 * differently from bash) are blocked. Suspicious-but-correctly-parsed
 * patterns are auto-accepted.
 */
export function validateBashCommand(command: string): SecurityResult {
  if (!command.trim()) return ok

  const ctx = buildContext(command)

  // --- Catastrophic destruction ---
  if (isBlockedBashCommand(command)) {
    return refused('Blocked an obviously catastrophic destructive command.')
  }

  // --- Misparsing-class validators (hard block) ---
  const misparsingValidators = [
    validateControlCharacters,
    validateCarriageReturn,
    validateUnicodeWhitespace,
    validateBackslashEscapedWhitespace,
    validateBackslashEscapedOperators,
    validateMidWordHash,
    validateCommentQuoteDesync,
    validateQuotedNewline,
    validateBraceExpansion
  ]

  for (const validator of misparsingValidators) {
    const result = validator(ctx)
    if (result.blocked) return result
  }

  return ok
}
