export interface StreamingMarkdownSegments {
  stableSegments: string[]
  activeSegment: string
}

export interface StreamingMarkdownSegmentOptions {
  maxActiveSegmentChars?: number
}

interface MarkdownFence {
  marker: '`' | '~'
  length: number
  indent: number
}

interface DisplayMathFence {
  length: number
  indent: number
}

const DEFAULT_MAX_ACTIVE_SEGMENT_CHARS = 1600
const LINE_RE = /[^\n]*\n|[^\n]+/g
const FENCE_RE = /^([ \t]{0,3})(`{3,}|~{3,})/
const DISPLAY_MATH_OPENING_RE = /^([ \t]{0,3})(\${2,})(?:[ \t]*[^$\n]*)?$/
const DISPLAY_MATH_CLOSING_RE = /^([ \t]{0,3})(\${2,})[ \t]*$/
const HEADING_RE = /^[ \t]{0,3}#{1,6}(?:\s+|$)/
const TOP_LEVEL_LIST_ITEM_RE = /^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])\s+/
const TOP_LEVEL_UNORDERED_LIST_ITEM_RE = /^[ \t]{0,3}[-+*]\s+/
const FOOTNOTE_RE = /\[\^[^\]\n]+\]|^[ \t]{0,3}\[\^[^\]\n]+\]:/m
const LINK_REFERENCE_RE = /\[[^\]\n]+\]\[[^\]\n]+\]|^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S/m

export function splitStreamingMarkdownSegments(
  markdown: string,
  options: StreamingMarkdownSegmentOptions = {}
): StreamingMarkdownSegments {
  if (hasDocumentScopedMarkdown(markdown)) {
    return {
      stableSegments: [],
      activeSegment: markdown
    }
  }

  const maxActiveSegmentChars = options.maxActiveSegmentChars ?? DEFAULT_MAX_ACTIVE_SEGMENT_CHARS
  const stableSegments: string[] = []
  let segmentStart = 0
  let offset = 0
  let fence: MarkdownFence | null = null
  let displayMath: DisplayMathFence | null = null
  let activeSegmentStartsWithList = false

  const cutSegment = (end: number): void => {
    if (end <= segmentStart) return
    const segment = markdown.slice(segmentStart, end)
    if (segment.trim().length > 0) {
      stableSegments.push(segment)
    }
    segmentStart = end
    activeSegmentStartsWithList = false
  }

  for (const line of markdown.match(LINE_RE) ?? []) {
    const lineStart = offset
    const lineEnd = lineStart + line.length
    const text = line.endsWith('\n') ? line.slice(0, -1) : line
    const trimmed = text.trim()

    if (lineStart === segmentStart && TOP_LEVEL_LIST_ITEM_RE.test(text)) {
      activeSegmentStartsWithList = true
    }

    if (fence) {
      if (closesFence(text, fence)) {
        fence = null
      }
      offset = lineEnd
      continue
    }

    if (displayMath) {
      if (closesDisplayMathFence(text, displayMath)) {
        displayMath = null
      }
      offset = lineEnd
      continue
    }

    const openingFence = readOpeningFence(text)
    if (openingFence) {
      if (openingFence.indent === 0 && lineStart > segmentStart) {
        cutSegment(lineStart)
      }
      fence = openingFence
      offset = lineEnd
      continue
    }

    const openingDisplayMath = readOpeningDisplayMathFence(text)
    if (openingDisplayMath) {
      if (openingDisplayMath.indent === 0 && lineStart > segmentStart) {
        cutSegment(lineStart)
      }
      displayMath = openingDisplayMath
      offset = lineEnd
      continue
    }

    if (trimmed.length === 0) {
      if (!activeSegmentStartsWithList && lineEnd < markdown.length) {
        cutSegment(lineEnd)
      }
      offset = lineEnd
      continue
    }

    if (lineStart > segmentStart && HEADING_RE.test(text)) {
      cutSegment(lineStart)
      offset = lineEnd
      continue
    }

    if (
      lineStart > segmentStart &&
      TOP_LEVEL_UNORDERED_LIST_ITEM_RE.test(text) &&
      lineStart - segmentStart >= maxActiveSegmentChars
    ) {
      cutSegment(lineStart)
      activeSegmentStartsWithList = true
    }

    offset = lineEnd
  }

  return {
    stableSegments,
    activeSegment: markdown.slice(segmentStart)
  }
}

function readOpeningFence(line: string): MarkdownFence | null {
  const match = line.match(FENCE_RE)
  const indent = match?.[1]
  const marker = match?.[2]
  if (!marker) return null

  return {
    marker: marker[0] as '`' | '~',
    length: marker.length,
    indent: indent?.length ?? 0
  }
}

function readOpeningDisplayMathFence(line: string): DisplayMathFence | null {
  const match = line.match(DISPLAY_MATH_OPENING_RE)
  const indent = match?.[1]
  const marker = match?.[2]
  if (!marker || indent === undefined) return null

  return {
    length: marker.length,
    indent: indent.length
  }
}

function closesDisplayMathFence(line: string, fence: DisplayMathFence): boolean {
  const match = line.match(DISPLAY_MATH_CLOSING_RE)
  const marker = match?.[2]
  return Boolean(marker && marker.length >= fence.length)
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const match = line.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/)
  const marker = match?.[1]
  return Boolean(marker && marker[0] === fence.marker && marker.length >= fence.length)
}

function hasDocumentScopedMarkdown(markdown: string): boolean {
  return FOOTNOTE_RE.test(markdown) || LINK_REFERENCE_RE.test(markdown)
}
