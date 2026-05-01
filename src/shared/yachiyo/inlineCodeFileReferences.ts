const DEFAULT_MAX_INLINE_CODE_FILE_REFERENCES = 64

export const INLINE_CODE_FILE_REFERENCE_ALLOWED_SUFFIXES = [
  '.astro',
  '.avif',
  '.babelrc',
  '.bash',
  '.bat',
  '.bmp',
  '.c',
  '.cc',
  '.cjs',
  '.clj',
  '.cljs',
  '.cmake',
  '.conf',
  '.config',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.cts',
  '.cxx',
  '.dart',
  '.diff',
  '.doc',
  '.docm',
  '.docx',
  '.dot',
  '.dotm',
  '.dotx',
  '.editorconfig',
  '.env',
  '.eslintignore',
  '.eslintrc',
  '.fish',
  '.gif',
  '.gitignore',
  '.go',
  '.graphql',
  '.gql',
  '.h',
  '.heic',
  '.hpp',
  '.htm',
  '.html',
  '.ico',
  '.ini',
  '.java',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.jsonc',
  '.jsonl',
  '.jsx',
  '.key',
  '.kt',
  '.kts',
  '.less',
  '.lock',
  '.log',
  '.lua',
  '.m',
  '.markdown',
  '.md',
  '.mdx',
  '.mjs',
  '.mm',
  '.mts',
  '.npmrc',
  '.numbers',
  '.odp',
  '.ods',
  '.odt',
  '.otp',
  '.ots',
  '.ott',
  '.pages',
  '.pdf',
  '.php',
  '.pl',
  '.pm',
  '.png',
  '.pot',
  '.potm',
  '.potx',
  '.pps',
  '.ppsm',
  '.ppsx',
  '.ppt',
  '.pptm',
  '.pptx',
  '.prettierignore',
  '.prettierrc',
  '.properties',
  '.proto',
  '.ps1',
  '.py',
  '.r',
  '.rb',
  '.rs',
  '.rtf',
  '.sass',
  '.scala',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.svg',
  '.swift',
  '.text',
  '.tif',
  '.tiff',
  '.toml',
  '.ts',
  '.tsx',
  '.tsv',
  '.txt',
  '.vue',
  '.webp',
  '.xls',
  '.xlsb',
  '.xlsm',
  '.xlsx',
  '.xlt',
  '.xltm',
  '.xltx',
  '.xml',
  '.yaml',
  '.yml',
  '.yarnrc',
  '.zig'
] as const

export function stripInlineCodeFileLocationSuffix(value: string): string {
  const lastColonIndex = value.lastIndexOf(':')
  if (lastColonIndex < 0) {
    return value
  }

  const lastSegment = value.slice(lastColonIndex + 1)
  if (!isDigitString(lastSegment)) {
    return value
  }

  const beforeLastSegment = value.slice(0, lastColonIndex)
  const secondColonIndex = beforeLastSegment.lastIndexOf(':')
  if (secondColonIndex < 0) {
    return beforeLastSegment
  }

  const secondSegment = beforeLastSegment.slice(secondColonIndex + 1)
  if (!isDigitString(secondSegment)) {
    return beforeLastSegment
  }

  return beforeLastSegment.slice(0, secondColonIndex)
}

export function isAbsoluteInlineCodeFileReference(value: string): boolean {
  const candidate = stripInlineCodeFileLocationSuffix(value.trim())
  return candidate.startsWith('/') || hasWindowsAbsolutePathPrefix(candidate)
}

export function isAllowedInlineCodeFileReference(value: string): boolean {
  const pathPart = stripInlineCodeFileLocationSuffix(value.trim())
  if (!pathPart || pathPart !== pathPart.trim()) {
    return false
  }

  const lowerPathPart = pathPart.toLowerCase()
  return INLINE_CODE_FILE_REFERENCE_ALLOWED_SUFFIXES.some((suffix) =>
    lowerPathPart.endsWith(suffix)
  )
}

export function toInlineCodeFileReferenceCandidate(value: string): string | null {
  const candidate = value.trim()
  if (!candidate || candidate.length > 500 || hasLineBreak(candidate)) {
    return null
  }

  if (hasUrlScheme(candidate)) {
    return null
  }

  const pathPart = stripInlineCodeFileLocationSuffix(candidate)
  if (!pathPart || pathPart !== pathPart.trim()) {
    return null
  }

  if (!isAllowedInlineCodeFileReference(pathPart)) {
    return null
  }

  return candidate
}

export function extractInlineCodeFileReferences(
  markdown: string,
  maxReferences = DEFAULT_MAX_INLINE_CODE_FILE_REFERENCES
): string[] {
  const references: string[] = []
  const seen = new Set<string>()
  let activeFence: { marker: string; length: number } | null = null

  function pushReference(value: string): void {
    const candidate = toInlineCodeFileReferenceCandidate(value)
    if (!candidate || seen.has(candidate)) {
      return
    }

    seen.add(candidate)
    references.push(candidate)
  }

  for (const line of splitMarkdownLines(markdown)) {
    const fence = readMarkdownFence(line)
    if (activeFence) {
      if (fence && fence.marker === activeFence.marker && fence.length >= activeFence.length) {
        activeFence = null
      }
      continue
    }

    if (fence) {
      activeFence = fence
      continue
    }

    collectInlineCodeReferencesFromLine(line, pushReference)
    if (references.length >= maxReferences) {
      return references.slice(0, maxReferences)
    }
  }

  return references
}

function collectInlineCodeReferencesFromLine(
  line: string,
  onReference: (value: string) => void
): void {
  let index = 0

  while (index < line.length) {
    if (line[index] !== '`') {
      index += 1
      continue
    }

    const delimiterLength = countBackticks(line, index)
    const contentStart = index + delimiterLength
    const contentEnd = findClosingBackticks(line, contentStart, delimiterLength)
    if (contentEnd < 0) {
      index = contentStart
      continue
    }

    onReference(normalizeCodeSpanContent(line.slice(contentStart, contentEnd)))
    index = contentEnd + delimiterLength
  }
}

function countBackticks(line: string, start: number): number {
  return countRepeatedCharacter(line, start, '`')
}

function findClosingBackticks(line: string, start: number, delimiterLength: number): number {
  let index = start
  while (index < line.length) {
    if (line[index] !== '`') {
      index += 1
      continue
    }

    const length = countBackticks(line, index)
    if (length === delimiterLength) {
      return index
    }
    index += length
  }

  return -1
}

function normalizeCodeSpanContent(value: string): string {
  const compacted = compactCodeSpanWhitespace(value)
  if (compacted.length >= 2 && compacted.startsWith(' ') && compacted.endsWith(' ')) {
    return compacted.slice(1, -1)
  }
  return compacted
}

function splitMarkdownLines(value: string): string[] {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
}

function readMarkdownFence(line: string): { marker: string; length: number } | null {
  let index = 0
  while (index < 3 && line[index] === ' ') {
    index += 1
  }

  const marker = line[index]
  if (marker !== '`' && marker !== '~') {
    return null
  }

  const length = countRepeatedCharacter(line, index, marker)
  if (length < 3) {
    return null
  }

  return { marker, length }
}

function compactCodeSpanWhitespace(value: string): string {
  let compacted = ''
  let previousWasInlineSpace = false

  for (const char of value) {
    const isInlineSpace = char === ' ' || char === '\t'
    if (isInlineSpace) {
      if (!previousWasInlineSpace) {
        compacted += ' '
      }
      previousWasInlineSpace = true
      continue
    }

    compacted += char
    previousWasInlineSpace = false
  }

  return compacted
}

function countRepeatedCharacter(line: string, start: number, marker: string): number {
  let index = start
  while (line[index] === marker) {
    index += 1
  }
  return index - start
}

function hasLineBreak(value: string): boolean {
  return value.includes('\n') || value.includes('\r')
}

function hasWindowsAbsolutePathPrefix(value: string): boolean {
  return (
    value.length >= 3 && isAsciiLetter(value[0]!) && value[1] === ':' && isPathSeparator(value[2]!)
  )
}

function hasUrlScheme(value: string): boolean {
  const separatorIndex = value.indexOf('://')
  if (separatorIndex <= 0 || !isAsciiLetter(value[0]!)) {
    return false
  }

  for (let index = 1; index < separatorIndex; index += 1) {
    const char = value[index]!
    if (
      !isAsciiLetter(char) &&
      !isAsciiDigit(char) &&
      char !== '+' &&
      char !== '.' &&
      char !== '-'
    ) {
      return false
    }
  }

  return true
}

function isPathSeparator(char: string): boolean {
  return char === '/' || char === '\\'
}

function isDigitString(value: string): boolean {
  if (!value) {
    return false
  }

  for (const char of value) {
    if (!isAsciiDigit(char)) {
      return false
    }
  }

  return true
}

function isAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isAsciiDigit(char: string): boolean {
  const code = char.charCodeAt(0)
  return code >= 48 && code <= 57
}
