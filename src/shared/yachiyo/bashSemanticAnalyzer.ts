/**
 * Lightweight bash semantic analyzer for tool-call grouping.
 *
 * Parses common bash constructs (quotes, subshells, pipes, redirects,
 * command lists) and classifies the dominant intent into the same
 * semantic groups used by native tools.
 */

export type BashSemanticGroup =
  | 'search-files'
  | 'read-files'
  | 'edit-files'
  | 'write-files'
  | 'run-commands'

interface ParsedStage {
  command: string
  args: string[]
  hasOutputRedirect: boolean
  hasInputRedirect: boolean
  hasHeredoc: boolean
}

// ------------------------------------------------------------------
// Tokenizer
// ------------------------------------------------------------------

function preprocessOperators(command: string): string {
  let result = ''
  let i = 0
  while (i < command.length) {
    const char = command[i]!

    // Single-quoted string: skip entirely
    if (char === "'") {
      let j = i + 1
      while (j < command.length && command[j] !== "'") j++
      result += command.slice(i, j + 1)
      i = j + 1
      continue
    }

    // Double-quoted string: skip escaped chars
    if (char === '"') {
      let j = i + 1
      while (j < command.length) {
        if (command[j] === '\\') {
          j += 2
          continue
        }
        if (command[j] === '"') break
        j++
      }
      result += command.slice(i, j + 1)
      i = j + 1
      continue
    }

    // Backtick command substitution
    if (char === '`') {
      let j = i + 1
      while (j < command.length) {
        if (command[j] === '\\') {
          j += 2
          continue
        }
        if (command[j] === '`') break
        j++
      }
      result += command.slice(i, j + 1)
      i = j + 1
      continue
    }

    // $(...) command substitution
    if (char === '$' && command[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      while (j < command.length && depth > 0) {
        if (command[j] === '$' && command[j + 1] === '(') {
          depth++
          j += 2
        } else if (command[j] === ')') {
          depth--
          j++
        } else {
          j++
        }
      }
      result += command.slice(i, j)
      i = j
      continue
    }

    // Multi-char operators
    if (char === '&' && command[i + 1] === '&') {
      result += ' && '
      i += 2
      continue
    }
    if (char === '|' && command[i + 1] === '|') {
      result += ' || '
      i += 2
      continue
    }
    if (char === '>' && command[i + 1] === '>') {
      result += ' >> '
      i += 2
      continue
    }
    if (char === '<' && command[i + 1] === '<') {
      const len = command[i + 2] === '<' ? 3 : 2
      result += ` ${command.slice(i, i + len)} `
      i += len
      continue
    }

    // Single-char operators / metacharacters
    if (';|&<>()'.includes(char)) {
      result += ` ${char} `
      i++
      continue
    }

    result += char
    i++
  }
  return result
}

function tokenize(command: string): string[] {
  return preprocessOperators(command)
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

// ------------------------------------------------------------------
// Command-list / pipeline splitting
// ------------------------------------------------------------------

function splitCommandList(tokens: string[]): string[][] {
  const groups: string[][] = []
  let current: string[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === ';' || t === '&&' || t === '||') {
      if (current.length > 0) {
        groups.push(current)
        current = []
      }
      i++
      continue
    }
    current.push(t)
    i++
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function splitPipeline(tokens: string[]): string[][] {
  const stages: string[][] = []
  let current: string[] = []
  for (const t of tokens) {
    if (t === '|') {
      if (current.length > 0) stages.push(current)
      current = []
    } else {
      current.push(t)
    }
  }
  if (current.length > 0) stages.push(current)
  return stages
}

// ------------------------------------------------------------------
// Stage parsing (redirects, command name, args)
// ------------------------------------------------------------------

function isNullRedirect(target: string | undefined): boolean {
  return target === '/dev/null'
}

function parseStage(tokens: string[]): ParsedStage {
  const args: string[] = []
  let hasOutputRedirect = false
  let hasInputRedirect = false
  let hasHeredoc = false
  let i = 0

  while (i < tokens.length) {
    const t = tokens[i]!

    // Heredocs
    if (t === '<<' || t === '<<<') {
      hasHeredoc = true
      i++ // skip delimiter / token
      if (i < tokens.length) i++
      continue
    }

    // Output redirects: >, >>, 2>, 1>, &>, etc.
    // preprocessOperators splits `2>/dev/null` into `2`, `>`, `/dev/null`,
    // so check if the previous arg is an fd number and pop it from args.
    if (t === '>' || t === '>>') {
      const target = i + 1 < tokens.length ? tokens[i + 1] : undefined
      // Pop trailing fd number from args (e.g. `2` from `2>/dev/null`)
      const prevArg = args.at(-1)
      if (prevArg && /^\d$/.test(prevArg)) {
        args.pop()
      }
      // Redirects to /dev/null are noise suppression, not file writes
      if (!isNullRedirect(target)) {
        hasOutputRedirect = true
      }
      i++
      if (i < tokens.length) i++ // skip filename
      continue
    }
    if (/^\d*>$/.test(t) || /^\d*>>$/.test(t) || /^&>$/.test(t)) {
      const target = i + 1 < tokens.length ? tokens[i + 1] : undefined
      if (!isNullRedirect(target)) {
        hasOutputRedirect = true
      }
      i++
      if (i < tokens.length) i++
      continue
    }

    // Input redirects: <, 0<
    if (t === '<') {
      hasInputRedirect = true
      i++
      if (i < tokens.length) i++
      continue
    }
    if (/^\d*<$/.test(t)) {
      hasInputRedirect = true
      i++
      if (i < tokens.length) i++
      continue
    }

    args.push(t)
    i++
  }

  const command = args[0] ?? ''
  return {
    command,
    args: args.slice(1),
    hasOutputRedirect,
    hasInputRedirect,
    hasHeredoc
  }
}

// ------------------------------------------------------------------
// Command-name helpers
// ------------------------------------------------------------------

function normalizeCommand(cmd: string): string {
  const base = cmd.toLowerCase()
  // Common version aliases
  if (base === 'python3' || base === 'py') return 'python'
  if (base === 'node' || base === 'nodejs') return 'node'
  if (base === 'ruby2' || base === 'ruby3') return 'ruby'
  if (base === 'perl5') return 'perl'
  if (base === 'gawk' || base === 'mawk' || base === 'nawk') return 'awk'
  if (base === 'fdfind') return 'fd'
  if (base === 'ripgrep') return 'rg'
  if (base === 'ack-grep') return 'ack'
  return base
}

// ------------------------------------------------------------------
// Grep / rg read-vs-search heuristic
// ------------------------------------------------------------------

function extractNonFlagOperands(args: string[]): string[] {
  const operands: string[] = []
  let i = 0
  while (i < args.length) {
    const a = args[i]!
    if (a === '-e' || a === '-f') {
      i += 2
      continue
    }
    if (a.startsWith('--')) {
      if (a.includes('=')) {
        i++
        continue
      }
      // Long flags like --color, --max-count take next arg? Most don't, but be safe for known ones
      if (
        a === '--color' ||
        a === '--max-count' ||
        a === '--context' ||
        a === '--before-context' ||
        a === '--after-context' ||
        a === '--threads' ||
        a === '--type'
      ) {
        i += 2
        continue
      }
      i++
      continue
    }
    if (a.startsWith('-')) {
      i++
      continue
    }
    operands.push(a)
    i++
  }
  return operands
}

function hasExplicitPatternFlag(args: string[]): boolean {
  for (const a of args) {
    if (a === '-e' || a === '-f') return true
  }
  return false
}

function isGrepSearchMode(stage: ParsedStage): boolean {
  const args = stage.args
  for (const a of args) {
    if (a === '-r' || a === '-R' || a === '-l' || a === '-L' || a === '-c' || a === '-q')
      return true
    if (
      a === '--recursive' ||
      a === '--files-with-matches' ||
      a === '--count' ||
      a === '--quiet' ||
      a === '--files-without-match'
    ) {
      return true
    }
    if (a.startsWith('-') && !a.startsWith('--')) {
      if (/[rlcLq]/.test(a)) return true
    }
  }

  const operands = extractNonFlagOperands(args)
  const hasExplicitPattern = hasExplicitPatternFlag(args)

  // When -e/-f is used, all non-flag operands are file targets.
  // Otherwise, the first non-flag operand is the pattern and the rest are files.
  const fileOperands = hasExplicitPattern ? operands : operands.slice(1)

  // No file operands -> implicit directory search (or xargs feeding via stdin)
  if (fileOperands.length === 0) return true
  // Multiple file operands -> search across files
  if (fileOperands.length > 1) return true
  const operand = fileOperands[0]!
  if (operand === '.' || operand.endsWith('/')) return true
  return false
}

// ------------------------------------------------------------------
// Per-stage classification
// ------------------------------------------------------------------

function stageHasInPlaceEdit(stage: ParsedStage): boolean {
  const cmd = normalizeCommand(stage.command)
  const args = stage.args
  const argStr = args.join(' ')

  switch (cmd) {
    case 'sed':
      return args.some((a) => a.startsWith('-i') || a === '-i')
    case 'perl':
      return args.some((a) => a.includes('i') && a.startsWith('-'))
    case 'ruby':
      return args.some((a) => (a.startsWith('-i') || a.includes('i')) && a.startsWith('-'))
    case 'ex':
    case 'ed':
      return true
    case 'python':
    case 'node':
      // Very rough heuristic: in-place file modification script
      return (
        /open\s*\(\s*['"]/.test(argStr) && (/write\s*\(/.test(argStr) || /\.write/.test(argStr))
      )
    default:
      return false
  }
}

function isRunCommand(stage: ParsedStage): boolean {
  return classifyStage(stage) === 'run-commands' || classifyStage(stage) === null
}

function extractXargsSubcommand(stages: ParsedStage[]): ParsedStage | null {
  // Find the first xargs stage and extract the wrapped command
  for (const stage of stages) {
    if (normalizeCommand(stage.command) !== 'xargs') continue
    // Skip xargs flags until we hit the subcommand
    let i = 0
    while (i < stage.args.length) {
      const a = stage.args[i]!
      if (a === '-I' || a === '-i' || a === '--replace') {
        i += 2
        continue
      }
      if (a.startsWith('-I') || a.startsWith('--replace=')) {
        i++
        continue
      }
      if (a.startsWith('-')) {
        i++
        continue
      }
      break
    }
    if (i < stage.args.length) {
      const sub = stage.args[i]!
      return {
        command: sub,
        args: stage.args.slice(i + 1),
        hasOutputRedirect: false,
        hasInputRedirect: false,
        hasHeredoc: false
      }
    }
  }
  return null
}

function classifyStage(stage: ParsedStage): BashSemanticGroup | null {
  const cmd = normalizeCommand(stage.command)

  // Git subcommand dispatch
  if (cmd === 'git') {
    const sub = stage.args[0] ? normalizeCommand(stage.args[0]) : ''
    if (sub === 'grep') return 'search-files'
    if (
      sub === 'show' ||
      sub === 'diff' ||
      sub === 'log' ||
      sub === 'blame' ||
      sub === 'status' ||
      sub === 'ls-files'
    ) {
      return 'read-files'
    }
    return 'run-commands'
  }

  // Find with -exec / -ok
  if (cmd === 'find') {
    const execIdx = stage.args.findIndex((a) => a === '-exec' || a === '-ok')
    if (execIdx >= 0 && execIdx + 1 < stage.args.length) {
      const sub = normalizeCommand(stage.args[execIdx + 1]!)
      if (sub === 'cat' || sub === 'head' || sub === 'tail' || sub === 'sed' || sub === 'awk') {
        // Check if sed is in-place
        const subArgs = stage.args.slice(execIdx + 2)
        const subStage: ParsedStage = {
          command: sub,
          args: subArgs,
          hasOutputRedirect: false,
          hasInputRedirect: false,
          hasHeredoc: false
        }
        if (stageHasInPlaceEdit(subStage)) return 'edit-files'
        return 'read-files'
      }
      if (sub === 'grep' || sub === 'rg') return 'search-files'
    }
    return 'search-files'
  }

  // Explicit search tools (may downgrade to read-files for targeted extraction)
  if (
    cmd === 'grep' ||
    cmd === 'egrep' ||
    cmd === 'fgrep' ||
    cmd === 'rg' ||
    cmd === 'ag' ||
    cmd === 'ack'
  ) {
    return isGrepSearchMode(stage) ? 'search-files' : 'read-files'
  }

  if (cmd === 'fd' || cmd === 'locate' || cmd === 'fzf') {
    return 'search-files'
  }

  // Explicit read tools
  if (
    cmd === 'cat' ||
    cmd === 'head' ||
    cmd === 'tail' ||
    cmd === 'less' ||
    cmd === 'more' ||
    cmd === 'nl' ||
    cmd === 'od' ||
    cmd === 'strings' ||
    cmd === 'xxd' ||
    cmd === 'hexdump' ||
    cmd === 'tac' ||
    cmd === 'rev' ||
    cmd === 'column' ||
    cmd === 'paste' ||
    cmd === 'cut' ||
    cmd === 'file' ||
    cmd === 'stat' ||
    cmd === 'ls' ||
    cmd === 'tree' ||
    cmd === 'jq' ||
    cmd === 'yq' ||
    cmd === 'wc' ||
    cmd === 'sort' ||
    cmd === 'uniq' ||
    cmd === 'tr' ||
    cmd === 'diff' ||
    cmd === 'cmp' ||
    cmd === 'readlink' ||
    cmd === 'realpath'
  ) {
    return 'read-files'
  }

  if (cmd === 'sed') {
    return stageHasInPlaceEdit(stage) ? 'edit-files' : 'read-files'
  }

  if (cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk' || cmd === 'nawk') {
    return 'read-files'
  }

  // Explicit write generators — only when they actually hit a file sink
  if (
    cmd === 'tee' ||
    ((cmd === 'echo' || cmd === 'printf' || cmd === 'yes' || cmd === 'seq') &&
      stage.hasOutputRedirect)
  ) {
    return 'write-files'
  }

  // Edit tools
  if (cmd === 'perl' || cmd === 'ruby') {
    return stageHasInPlaceEdit(stage) ? 'edit-files' : 'run-commands'
  }

  if (cmd === 'ex' || cmd === 'ed') {
    return 'edit-files'
  }

  if (cmd === 'python' || cmd === 'node') {
    return stageHasInPlaceEdit(stage) ? 'edit-files' : 'run-commands'
  }

  return null
}

// ------------------------------------------------------------------
// Pipeline / command-list classification
// ------------------------------------------------------------------

const SETUP_COMMANDS = new Set([
  'cd',
  'pushd',
  'popd',
  'export',
  'unset',
  'alias',
  'unalias',
  'source',
  '.',
  'pwd',
  'hostname',
  'whoami',
  'id',
  'date',
  'env',
  'printenv'
])

function resolvePrimaryStage(stages: ParsedStage[]): ParsedStage | null {
  for (const stage of stages) {
    if (!SETUP_COMMANDS.has(normalizeCommand(stage.command))) {
      return stage
    }
  }
  return stages[0] ?? null
}

function resolvePipelineGroup(stages: ParsedStage[]): BashSemanticGroup {
  // 1. In-place edit anywhere in the pipeline → edit-files
  for (const stage of stages) {
    if (stageHasInPlaceEdit(stage)) return 'edit-files'
  }

  // 2. Output redirect in any stage → write-files, unless the primary intent
  //    is clearly a run-commands tool (e.g. npm test > log.txt).
  const hasOutputRedirect = stages.some((s) => s.hasOutputRedirect)
  const primary = resolvePrimaryStage(stages)
  if (hasOutputRedirect && primary) {
    if (!isRunCommand(primary)) return 'write-files'
  }

  if (!primary) return 'run-commands'

  // 3. Check xargs subcommand (it overrides the primary if xargs is the driver)
  const xargsSub = extractXargsSubcommand(stages)
  const effectivePrimary = xargsSub ?? primary

  // 4. Classify by effective primary
  const primaryGroup = classifyStage(effectivePrimary)
  if (primaryGroup) {
    // If the pipeline ends with a search tool but starts with read,
    // e.g. cat file | grep foo, prefer read-files.
    const last = stages.at(-1)
    if (last) {
      const lastGroup = classifyStage(last)
      if (
        primaryGroup === 'search-files' &&
        lastGroup === 'read-files' &&
        normalizeCommand(primary.command) !== 'find' &&
        normalizeCommand(primary.command) !== 'git'
      ) {
        // If first stage is a read command, the pipeline is about reading
        const firstReal = resolvePrimaryStage(stages)
        if (firstReal) {
          const firstGroup = classifyStage(firstReal)
          if (firstGroup === 'read-files') return 'read-files'
        }
      }
    }
    return primaryGroup
  }

  return 'run-commands'
}

// ------------------------------------------------------------------
// Public entry point
// ------------------------------------------------------------------

export function resolveBashSemanticGroup(command: string): BashSemanticGroup {
  const tokens = tokenize(command)
  const groups = splitCommandList(tokens)
  if (groups.length === 0) return 'run-commands'

  // Analyze command groups in order, skipping pure setup groups (cd, export, etc.)
  for (const group of groups) {
    const stages = splitPipeline(group).map(parseStage)
    if (stages.length === 0) continue
    const primary = resolvePrimaryStage(stages)
    if (!primary) continue
    if (SETUP_COMMANDS.has(normalizeCommand(primary.command))) continue
    return resolvePipelineGroup(stages)
  }

  return 'run-commands'
}
