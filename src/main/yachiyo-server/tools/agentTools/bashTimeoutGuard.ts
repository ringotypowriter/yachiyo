interface SleepTimeoutConflict {
  sleepCommand: string
  sleepSeconds: number
  timeoutSeconds: number
}

interface HeredocMarker {
  delimiter: string
  stripTabs: boolean
}

interface CommandSegment {
  text: string
  operatorAfter?: string
}

const SLEEP_DURATION_MULTIPLIERS: Record<string, number> = {
  '': 1,
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60
}

function maskQuotedShellContent(command: string): string {
  let output = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (escaped) {
      output += inSingleQuote || inDoubleQuote ? ' ' : char
      escaped = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      output += inDoubleQuote ? ' ' : char
      escaped = true
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      output += ' '
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === '"' && !inSingleQuote) {
      output += ' '
      inDoubleQuote = !inDoubleQuote
      continue
    }

    output += inSingleQuote || inDoubleQuote ? ' ' : char
  }

  return output
}

function readHeredocDelimiter(line: string, startIndex: number): HeredocMarker | undefined {
  let i = startIndex
  let stripTabs = false

  if (line[i] === '-') {
    stripTabs = true
    i += 1
  }

  while (line[i] === ' ' || line[i] === '\t') {
    i += 1
  }

  let delimiter = ''
  let quote: string | undefined

  for (; i < line.length; i++) {
    const char = line[i]!

    if (quote) {
      if (char === quote) {
        quote = undefined
      } else {
        delimiter += char
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      continue
    }

    if (/\s/u.test(char) || char === ';' || char === '&' || char === '|') {
      break
    }

    delimiter += char
  }

  return delimiter.length > 0 ? { delimiter, stripTabs } : undefined
}

function collectHeredocMarkers(line: string): HeredocMarker[] {
  const markers: HeredocMarker[] = []
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!

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

    if (inSingleQuote || inDoubleQuote) {
      continue
    }

    if (char !== '<' || line[i + 1] !== '<' || line[i + 2] === '<') {
      continue
    }

    const marker = readHeredocDelimiter(line, i + 2)
    if (marker) {
      markers.push(marker)
    }
  }

  return markers
}

function maskLine(line: string): string {
  return ' '.repeat(line.length)
}

function maskHeredocBodies(command: string): string {
  const lines = command.split(/(?<=\n)/u)
  const pendingMarkers: HeredocMarker[] = []
  let masked = ''

  for (const lineWithEnding of lines) {
    const hasLineFeed = lineWithEnding.endsWith('\n')
    const line = hasLineFeed ? lineWithEnding.slice(0, -1) : lineWithEnding
    const lineWithoutCarriageReturn = line.endsWith('\r') ? line.slice(0, -1) : line
    const ending = hasLineFeed ? '\n' : ''

    if (pendingMarkers.length > 0) {
      const marker = pendingMarkers[0]!
      const delimiterLine = marker.stripTabs
        ? lineWithoutCarriageReturn.replace(/^\t+/u, '')
        : lineWithoutCarriageReturn

      if (delimiterLine === marker.delimiter) {
        pendingMarkers.shift()
      }

      masked += maskLine(line) + ending
      continue
    }

    masked += line + ending
    pendingMarkers.push(...collectHeredocMarkers(lineWithoutCarriageReturn))
  }

  return masked
}

function parseSleepDurationToken(token: string): number | undefined {
  const match = /^((?:\d+(?:\.\d+)?)|(?:\.\d+))([smhd]?)$/iu.exec(token)
  if (!match) {
    return undefined
  }

  const value = Number.parseFloat(match[1]!)
  if (!Number.isFinite(value)) {
    return undefined
  }

  const multiplier = SLEEP_DURATION_MULTIPLIERS[match[2]!.toLowerCase()]
  return multiplier === undefined ? undefined : value * multiplier
}

function parseSleepDurationSequence(value: string): number | undefined {
  let seconds = 0

  for (const token of value.trim().split(/[ \t]+/u)) {
    const duration = parseSleepDurationToken(token)
    if (duration === undefined) {
      return undefined
    }
    seconds += duration
  }

  return seconds
}

function splitCommandSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = []
  let start = 0

  const pushSegment = (end: number, operatorAfter: string): void => {
    segments.push({ text: command.slice(start, end), operatorAfter })
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    const nextChar = command[i + 1]

    if ((char === '&' || char === '|') && nextChar === char) {
      pushSegment(i, `${char}${char}`)
      i += 1
      start = i + 1
      continue
    }

    if (char === ';' || char === '\n' || char === '&' || char === '|') {
      pushSegment(i, char)
      start = i + 1
    }
  }

  segments.push({ text: command.slice(start) })
  return segments
}

function normalizeCommandToken(token: string): string {
  const lastSlash = token.lastIndexOf('/')
  return lastSlash >= 0 ? token.slice(lastSlash + 1) : token
}

function getSleepCommand(segment: string): { command: string; seconds: number } | undefined {
  const tokens = segment
    .trim()
    .split(/[ \t]+/u)
    .filter(Boolean)
  if (tokens.length < 2 || normalizeCommandToken(tokens[0]!) !== 'sleep') {
    return undefined
  }

  const durationTokens: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '--') {
      continue
    }

    if (parseSleepDurationToken(token) === undefined) {
      break
    }

    durationTokens.push(token)
  }

  if (durationTokens.length === 0) {
    return undefined
  }

  const seconds = parseSleepDurationSequence(durationTokens.join(' '))
  return seconds === undefined
    ? undefined
    : { command: `sleep ${durationTokens.join(' ')}`, seconds }
}

function hasFollowingCommand(segments: CommandSegment[], index: number): boolean {
  return segments.slice(index + 1).some((segment) => segment.text.trim().length > 0)
}

function shouldWaitForNextCommand(operatorAfter?: string): boolean {
  return operatorAfter === '&&' || operatorAfter === ';' || operatorAfter === '\n'
}

function findChainedSleepTimeoutConflict(
  command: string,
  timeoutSeconds: number
): SleepTimeoutConflict | undefined {
  const executableCommand = maskQuotedShellContent(maskHeredocBodies(command))
  const segments = splitCommandSegments(executableCommand)
  let sleepSeconds = 0
  const sleepCommands: string[] = []

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    const sleep = getSleepCommand(segment.text)

    if (!sleep) {
      sleepSeconds = 0
      sleepCommands.length = 0
      continue
    }

    sleepSeconds += sleep.seconds
    sleepCommands.push(sleep.command)

    if (
      sleepSeconds >= timeoutSeconds &&
      shouldWaitForNextCommand(segment.operatorAfter) &&
      hasFollowingCommand(segments, i)
    ) {
      return {
        sleepCommand: sleepCommands.join(' + '),
        sleepSeconds,
        timeoutSeconds
      }
    }

    if (!shouldWaitForNextCommand(segment.operatorAfter)) {
      sleepSeconds = 0
      sleepCommands.length = 0
    }
  }

  return undefined
}

function formatSeconds(seconds: number): string {
  if (Number.isInteger(seconds)) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`
  }
  return `${seconds.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '')} seconds`
}

function formatSleepTimeoutConflict(conflict: SleepTimeoutConflict): string {
  return (
    `Refusing to run \`${conflict.sleepCommand}\` before a following command because the sleep is ` +
    `${formatSeconds(conflict.sleepSeconds)}, but the bash timeout is ${formatSeconds(conflict.timeoutSeconds)}. ` +
    'Increase the timeout above the whole command duration, shorten the sleep, or use background mode only if the follow-up work can run asynchronously.'
  )
}

export function getChainedSleepTimeoutBlockMessage(
  command: string,
  timeoutSeconds: number
): string | undefined {
  const conflict = findChainedSleepTimeoutConflict(command, timeoutSeconds)
  return conflict ? formatSleepTimeoutConflict(conflict) : undefined
}
