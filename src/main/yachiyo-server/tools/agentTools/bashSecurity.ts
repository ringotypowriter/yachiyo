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

import { homedir } from 'os'
import { resolve } from 'path'

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
// Scope-of-scan validator (scan range too broad)
// ---------------------------------------------------------------------------
// Not a misparsing threat — a policy block. Matches the same intent as
// `isForbiddenHugeSearchRoot` in the glob/grep tools: refuse recursive scans
// rooted at `/` or the user's home directory because the agent almost never
// wants that and it wedges the session.

/** Commands whose positional arguments are all paths (recurse by default). */
const PATH_ONLY_RECURSIVE_COMMANDS = new Set(['find', 'tree', 'du'])

/**
 * Pattern-first scan commands: the first positional is the search pattern,
 * subsequent positionals are paths. `rg / src` is a narrow scan for the
 * literal `/` inside `src`, NOT a scan of the filesystem root.
 */
const PATTERN_FIRST_RECURSIVE_COMMANDS = new Set(['rg', 'ag', 'ack', 'fd', 'fdfind'])

/** Commands that recurse only when a flag is passed. */
const CONDITIONAL_RECURSIVE_SCAN_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'ls'])

/** Pattern-first commands among the conditional recursers. */
const CONDITIONAL_PATTERN_FIRST_COMMANDS = new Set(['grep', 'egrep', 'fgrep'])

/**
 * Tokens that name a forbidden huge-scan root after shell unquoting.
 * Matches `/`, `~`, `~/`, `$HOME`, `$HOME/`, `${HOME}`, `${HOME}/`.
 * Narrow subpaths like `~/Downloads` or `$HOME/projects` must NOT match.
 */
const HUGE_ROOT_TOKEN_RE = /^(?:\/|~\/?|\$HOME\/?|\$\{HOME\}\/?)$/

/**
 * Check whether a token resolves to a forbidden huge-scan root.
 * Catches the regex-based forms AND absolute paths like `/Users/alice`
 * that resolve to the actual home directory or filesystem root.
 */
function isHugeRootToken(token: string): boolean {
  if (HUGE_ROOT_TOKEN_RE.test(token)) return true

  // Resolve absolute paths and check against the actual home directory.
  // Only applies to tokens that look like absolute paths — skip shell
  // variables and tilde (already handled by the regex above).
  if (token.startsWith('/')) {
    const resolved = resolve(token.replace(/\/+$/, '') || '/')
    if (resolved === '/' || resolved === resolve(homedir())) return true
  }

  return false
}

// `find`'s multi-argument flags: they consume tokens until `;` or `+`.
const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/**
 * Sudo/doas/env value-taking flags. Not exhaustive — covers the common forms
 * so the wrapper-normalization loop doesn't misread a flag's argument as the
 * wrapped command name.
 */
const SUDO_VALUE_FLAGS = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-C',
  '--close-from',
  '-D',
  '--chdir',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-R',
  '--chroot',
  '-T',
  '--command-timeout',
  '-U',
  '--other-user'
])

const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir'])

/**
 * Strip command prefixes so wrappers like `sudo find / ...`, `LC_ALL=C rg ...`,
 * and `env sudo find /` don't bypass the scan-root check. Handles in any
 * interleaving:
 *   - Leading `VAR=value` env assignments
 *   - `sudo` / `doas` with boolean and value-taking flags (stops at `--`)
 *   - `env [flags] [VAR=value...]`
 *   - `exec`
 *
 * Returns a sliced token list whose first entry is the actual command
 * (possibly still path-prefixed — see normalizeBaseCommand).
 */
function normalizeCommandPrefix(tokens: string[]): string[] {
  const isEnvAssignment = (token: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)

  let i = 0
  for (;;) {
    const start = i

    while (i < tokens.length && isEnvAssignment(tokens[i]!)) {
      i++
    }

    if (i >= tokens.length) break
    const next = tokens[i]!

    if (next === 'sudo' || next === 'doas') {
      i++
      while (i < tokens.length && tokens[i]!.startsWith('-')) {
        const flag = tokens[i]!
        i++
        if (flag === '--') break
        if (SUDO_VALUE_FLAGS.has(flag) && i < tokens.length && !tokens[i]!.startsWith('-')) {
          i++
        }
      }
      continue
    }

    if (next === 'env') {
      i++
      while (i < tokens.length && tokens[i]!.startsWith('-')) {
        const flag = tokens[i]!
        i++
        if (flag === '--') break
        if (ENV_VALUE_FLAGS.has(flag) && i < tokens.length && !tokens[i]!.startsWith('-')) {
          i++
        }
      }
      // `env` also accepts inline VAR=value before the wrapped command;
      // the next loop iteration's env-assignment sweep will pick those up.
      continue
    }

    if (next === 'exec') {
      i++
      continue
    }

    if (i === start) break
  }

  return tokens.slice(i)
}

/** Strip a leading path prefix: `/usr/bin/find` → `find`, `./rg` → `rg`. */
function normalizeBaseCommand(token: string): string {
  const lastSlash = token.lastIndexOf('/')
  return lastSlash >= 0 ? token.slice(lastSlash + 1) : token
}

/**
 * Per-command set of flags that consume the NEXT token as their value.
 * Not exhaustive — covers common filter/context/glob flags so narrow scans
 * like `rg --glob '*.ts' / src` and `fd --extension ts / src` aren't
 * misread (the flag's argument gets counted as a positional otherwise).
 * Missing entries may still cause edge-case false positives; acceptable
 * for a productivity guard.
 */
const RG_VALUE_FLAGS = new Set([
  '-e',
  '--regexp',
  '-f',
  '--file',
  '-g',
  '--glob',
  '--iglob',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '--type-add',
  '--include-dir',
  '-m',
  '--max-count',
  '--max-depth',
  '--max-filesize',
  '-C',
  '--context',
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-r',
  '--replace',
  '--sort',
  '--sortr',
  '--engine',
  '--color',
  '--colors',
  '--encoding',
  '-M',
  '--max-columns',
  '--pre',
  '--pre-glob',
  '--context-separator',
  '--ignore-file'
])

const FD_VALUE_FLAGS = new Set([
  '-e',
  '--extension',
  '-t',
  '--type',
  '-d',
  '--max-depth',
  '--min-depth',
  '--exact-depth',
  '-E',
  '--exclude',
  '-x',
  '--exec',
  '-X',
  '--exec-batch',
  '-S',
  '--size',
  '--changed-within',
  '--changed-before',
  '-c',
  '--color',
  '--max-results',
  '--base-directory',
  '--format',
  '--search-path',
  '-j',
  '--threads',
  '--ignore-file'
])

const GREP_VALUE_FLAGS = new Set([
  '-e',
  '--regexp',
  '-f',
  '--file',
  '-m',
  '--max-count',
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-C',
  '--context',
  '--include',
  '--exclude',
  '--include-dir',
  '--exclude-dir',
  '--include-from',
  '--exclude-from',
  '--color',
  '--colour',
  '--binary-files',
  '-D',
  '--devices',
  '-d',
  '--directories',
  '--label',
  '--group-separator'
])

const AG_VALUE_FLAGS = new Set([
  '-A',
  '--after',
  '-B',
  '--before',
  '-C',
  '--context',
  '-G',
  '--file-search-regex',
  '-g',
  '-m',
  '--max-count',
  '--ignore',
  '--ignore-dir',
  '--depth',
  '--pager',
  '-p',
  '--path-to-ignore'
])

const ACK_VALUE_FLAGS = new Set([
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-C',
  '--context',
  '-m',
  '--max-count',
  '-g',
  '--match',
  '--type',
  '--ignore-dir',
  '--ignore-file',
  '--range-start',
  '--range-end',
  '--output',
  '--pager'
])

const FIND_VALUE_FLAGS = new Set([
  '-name',
  '-iname',
  '-type',
  '-xtype',
  '-maxdepth',
  '-mindepth',
  '-size',
  '-mtime',
  '-atime',
  '-ctime',
  '-mmin',
  '-amin',
  '-cmin',
  '-user',
  '-uid',
  '-group',
  '-gid',
  '-perm',
  '-path',
  '-ipath',
  '-regex',
  '-iregex',
  '-regextype',
  '-newer',
  '-anewer',
  '-cnewer',
  '-wholename',
  '-iwholename',
  '-lname',
  '-ilname',
  '-inum',
  '-links',
  '-samefile',
  '-fstype',
  '-context',
  '-used',
  '-printf',
  '-fprintf',
  '-fprint',
  '-fprint0'
])

const TREE_VALUE_FLAGS = new Set([
  '-I',
  '-P',
  '-L',
  '--filelimit',
  '--timefmt',
  '-o',
  '--matchdirs',
  '--charset',
  '--gitfile',
  '--fromfile',
  '--sort'
])

const DU_VALUE_FLAGS = new Set([
  '-B',
  '--block-size',
  '--exclude',
  '-X',
  '--exclude-from',
  '-d',
  '--max-depth',
  '-t',
  '--threshold',
  '--time-style',
  '--files0-from'
])

const LS_VALUE_FLAGS = new Set([
  '-I',
  '--ignore',
  '-w',
  '--width',
  '-T',
  '--tabsize',
  '--block-size',
  '--color',
  '--format',
  '--sort',
  '--time',
  '--time-style',
  '--indicator-style',
  '--quoting-style',
  '--hide',
  '--hyperlink'
])

const VALUE_FLAGS_PER_COMMAND: Record<string, Set<string>> = {
  rg: RG_VALUE_FLAGS,
  fd: FD_VALUE_FLAGS,
  fdfind: FD_VALUE_FLAGS,
  grep: GREP_VALUE_FLAGS,
  egrep: GREP_VALUE_FLAGS,
  fgrep: GREP_VALUE_FLAGS,
  ag: AG_VALUE_FLAGS,
  ack: ACK_VALUE_FLAGS,
  find: FIND_VALUE_FLAGS,
  tree: TREE_VALUE_FLAGS,
  du: DU_VALUE_FLAGS,
  ls: LS_VALUE_FLAGS
}

/**
 * Flags that supply the search pattern EXTERNALLY (not as a positional).
 * When present, the "skip first positional as pattern" rule is disabled
 * because every positional is now a path, e.g. `rg -e foo / src` scans
 * both `/` and `src`.
 */
const RG_PATTERN_FLAGS = new Set(['-e', '--regexp', '-f', '--file'])
const GREP_PATTERN_FLAGS = new Set(['-e', '--regexp', '-f', '--file'])

const PATTERN_FLAG_PROVIDERS: Record<string, Set<string>> = {
  rg: RG_PATTERN_FLAGS,
  grep: GREP_PATTERN_FLAGS,
  egrep: GREP_PATTERN_FLAGS,
  fgrep: GREP_PATTERN_FLAGS,
  ack: new Set(['--match'])
}

// Short-flag cluster (e.g. `-r`, `-lR`). Excludes long flags (`--role`).
function isShortFlagCluster(token: string): boolean {
  return /^-[a-zA-Z]+$/.test(token)
}

// Command-aware recursive-flag detection: `ls -r` is sort-reverse, NOT
// recursive — only `-R` enables ls recursion. grep/egrep/fgrep treat both
// `-r` and `-R` as equivalent.
function hasRecursiveFlag(flagTokens: string[], command: string): boolean {
  if (flagTokens.includes('--recursive')) return true
  const recursiveChars = command === 'ls' ? 'R' : 'rR'
  for (const token of flagTokens) {
    if (!isShortFlagCluster(token)) continue
    for (const ch of token.slice(1)) {
      if (recursiveChars.includes(ch)) return true
    }
  }
  return false
}

/**
 * Walk tokens, skipping flags (and their values where known), returning the
 * remaining positional arguments. Handles:
 *   - `--flag=value` (self-contained)
 *   - `--flag value` when `--flag` is in the command's VALUE_FLAGS set
 *   - `find -exec CMD ... ;` / `... +` (multi-token consumption)
 *   - unknown flags are treated as boolean (skip single token)
 */
function extractPositionals(tokens: string[], command: string): string[] {
  const valueFlags = VALUE_FLAGS_PER_COMMAND[command]
  const positionals: string[] = []

  let i = 1
  while (i < tokens.length) {
    const token = tokens[i]!

    if (command === 'find' && FIND_EXEC_FLAGS.has(token)) {
      i++
      while (i < tokens.length && tokens[i] !== ';' && tokens[i] !== '+') i++
      if (i < tokens.length) i++
      continue
    }

    if (token.startsWith('-')) {
      if (token.includes('=')) {
        i++
        continue
      }
      if (valueFlags?.has(token)) {
        i += 2
        continue
      }
      i++
      continue
    }

    positionals.push(token)
    i++
  }

  return positionals
}

// Pattern-first commands normally skip positional #0 as the search pattern.
// But if a pattern-providing flag (`-e`, `-f`, ...) is present, the pattern
// came from the flag and every positional is actually a path.
function commandHasPatternFlag(tokens: string[], command: string): boolean {
  const providers = PATTERN_FLAG_PROVIDERS[command]
  if (!providers) return false
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (providers.has(token)) return true
    for (const provider of providers) {
      if (token.startsWith(`${provider}=`)) return true
    }
  }
  return false
}

function validateHugeSearchRoot(ctx: ValidationContext): SecurityResult {
  // fullyUnquotedContent strips quoted content — this is a productivity
  // guard, not a security boundary, so quoted edge cases (`find "/"`,
  // single-quoted flag values) are best-effort.
  const segments = ctx.fullyUnquotedContent
    .split(/[;&|]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)

  for (const segment of segments) {
    const rawTokens = segment.split(/\s+/).filter(Boolean)
    // Strip wrappers (sudo, env, LC_ALL=C, path prefixes) so `sudo find / ...`
    // and `/usr/bin/find / ...` classify against the real scanner.
    const tokens = normalizeCommandPrefix(rawTokens)
    if (tokens.length === 0) continue

    const base = normalizeBaseCommand(tokens[0]!)
    const isPathOnly = PATH_ONLY_RECURSIVE_COMMANDS.has(base)
    const isPatternFirst = PATTERN_FIRST_RECURSIVE_COMMANDS.has(base)
    const isConditional = CONDITIONAL_RECURSIVE_SCAN_COMMANDS.has(base)

    if (!isPathOnly && !isPatternFirst && !isConditional) continue

    if (isConditional && !hasRecursiveFlag(tokens.slice(1), base)) continue

    const positionals = extractPositionals(tokens, base)

    const isPatternFirstCommand =
      isPatternFirst || (isConditional && CONDITIONAL_PATTERN_FIRST_COMMANDS.has(base))
    const skipFirstPositional =
      isPatternFirstCommand && !commandHasPatternFlag(tokens, base) ? 1 : 0

    for (let i = skipFirstPositional; i < positionals.length; i++) {
      const token = positionals[i]!
      if (isHugeRootToken(token)) {
        return refused(
          `Command scans \`${token}\` with \`${base}\` — the scan range is too large. Pick a more specific subdirectory instead of the filesystem root or home.`
        )
      }
    }
  }

  return ok
}

// ---------------------------------------------------------------------------
// Self-launch prevention
// ---------------------------------------------------------------------------

/**
 * Block commands that would launch or activate Yachiyo — running the host
 * app from inside its own agent is a recursive-launch footgun that cascades
 * into catastrophic resource exhaustion.
 *
 * Catches:
 * - Any path containing `Yachiyo.app`
 * - AppleScript / osascript targeting application "Yachiyo"
 */
export function isSelfLaunchCommand(command: string): boolean {
  if (/Yachiyo\.app\b/.test(command)) return true
  // osascript -e '... application "Yachiyo" ...' or similar
  if (/osascript\b/.test(command) && /application\s+["']Yachiyo["']/i.test(command)) return true
  return false
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

  // --- Self-launch prevention ---
  if (isSelfLaunchCommand(command)) {
    return refused(
      'Blocked: cannot launch Yachiyo.app from inside its own agent. ' +
        'This would cause recursive process spawning and resource exhaustion.'
    )
  }

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

  // --- Scope-of-scan validator (policy block) ---
  const scopeResult = validateHugeSearchRoot(ctx)
  if (scopeResult.blocked) return scopeResult

  return ok
}
