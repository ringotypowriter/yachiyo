interface ShellTokenLike {
  text: string
  start: number
  end: number
  operator?: boolean
}

interface TextRange {
  start: number
  end: number
}

interface HeredocBodyRangeOptions {
  tokenize: (command: string) => ShellTokenLike[]
  skipCommandPrefixes: (tokens: ShellTokenLike[]) => number
  filter?: (command: string) => boolean
  requireQuotedDelimiter?: boolean
}

interface HeredocSpec {
  delimiter: string
  allowLeadingTabs: boolean
  quotedDelimiter: boolean
}

interface HeredocEnd {
  bodyEnd: number
  nextStart: number
}

function parseHeredocToken(
  line: string,
  token: ShellTokenLike,
  nextToken?: ShellTokenLike
): HeredocSpec | undefined {
  const rawToken = line.slice(token.start, token.end)
  const match = /^(?:\d*)<<(-?)(.*)$/.exec(rawToken)
  if (!match || rawToken.startsWith('<<<')) return undefined

  const delimiter = token.text.replace(/^(?:\d*)<<-?/, '') || nextToken?.text
  if (!delimiter) return undefined

  const rawDelimiter = match[2] || (nextToken ? line.slice(nextToken.start, nextToken.end) : '')
  return {
    delimiter,
    allowLeadingTabs: match[1] === '-',
    quotedDelimiter: /['"\\]/.test(rawDelimiter)
  }
}

function isEscapedPhysicalNewline(command: string, newlineIndex: number): boolean {
  let backslashes = 0
  for (let i = newlineIndex - 1; i >= 0 && command[i] === '\\'; i--) backslashes++
  return backslashes % 2 === 1
}

function findHeredocBodyStart(command: string, newlineIndex: number): number {
  let lineEnd = newlineIndex
  let nextStart = newlineIndex + 1

  while (isEscapedPhysicalNewline(command, lineEnd)) {
    const nextNewline = command.indexOf('\n', nextStart)
    if (nextNewline === -1) return command.length
    lineEnd = nextNewline
    nextStart = nextNewline + 1
  }

  return nextStart
}

function findHeredocEnd(command: string, bodyStart: number, spec: HeredocSpec): HeredocEnd {
  let lineStart = bodyStart

  while (lineStart <= command.length) {
    const newlineIndex = command.indexOf('\n', lineStart)
    const lineEnd = newlineIndex === -1 ? command.length : newlineIndex
    const line = command.slice(lineStart, lineEnd)
    const candidate = spec.allowLeadingTabs ? line.replace(/^\t+/, '') : line

    if (candidate === spec.delimiter) {
      return {
        bodyEnd: lineStart,
        nextStart: newlineIndex === -1 ? command.length : newlineIndex + 1
      }
    }

    if (newlineIndex === -1) break
    lineStart = newlineIndex + 1
  }

  return {
    bodyEnd: command.length,
    nextStart: command.length
  }
}

export function findHeredocBodyRanges(
  command: string,
  options: HeredocBodyRangeOptions
): TextRange[] {
  const ranges: TextRange[] = []
  let lineStart = 0

  while (lineStart < command.length) {
    const newlineIndex = command.indexOf('\n', lineStart)
    if (newlineIndex === -1) break

    const line = command.slice(lineStart, newlineIndex)
    const lineTokens = options.tokenize(line).filter((token) => !token.operator)
    const commandIndex = options.skipCommandPrefixes(lineTokens)
    const commandToken = lineTokens[commandIndex]

    if (!commandToken || (options.filter && !options.filter(commandToken.text))) {
      lineStart = newlineIndex + 1
      continue
    }

    const specs: HeredocSpec[] = []
    for (let i = commandIndex + 1; i < lineTokens.length; i++) {
      const spec = parseHeredocToken(line, lineTokens[i]!, lineTokens[i + 1])
      if (spec && (!options.requireQuotedDelimiter || spec.quotedDelimiter)) specs.push(spec)
    }

    if (specs.length === 0) {
      lineStart = newlineIndex + 1
      continue
    }

    let bodyStart = findHeredocBodyStart(command, newlineIndex)
    for (const spec of specs) {
      const end = findHeredocEnd(command, bodyStart, spec)
      ranges.push({ start: bodyStart, end: end.bodyEnd })
      bodyStart = end.nextStart
    }
    lineStart = bodyStart
  }

  return ranges
}
