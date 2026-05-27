import { createHash } from 'node:crypto'

import type { ActivityOcrSnapshot } from '@yachiyo/shared/protocol'

export interface ActivityOcrLineInput {
  text: string
  confidence: number
}

export interface CleanActivityOcrLinesInput {
  lines: ActivityOcrLineInput[]
  minConfidence?: number
  minTextChars?: number
  maxTextChars?: number
  maxExcerptChars?: number
}

const DEFAULT_MIN_CONFIDENCE = 0.5
const DEFAULT_MIN_TEXT_CHARS = 20
const DEFAULT_MAX_TEXT_CHARS = 1200
const DEFAULT_MAX_EXCERPT_CHARS = 160

function normalizeLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length
}

function semanticCharCount(text: string): number {
  return countMatches(text, /[\p{L}\p{N}]/gu)
}

function letterCount(text: string): number {
  return countMatches(text, /\p{L}/gu)
}

function digitCount(text: string): number {
  return countMatches(text, /\p{N}/gu)
}

function hasWordBoundary(text: string): boolean {
  return /[\s:：/|•·—–-]/u.test(text)
}

function isMostlySymbols(text: string): boolean {
  const semanticChars = semanticCharCount(text)
  return semanticChars === 0 || semanticChars / Array.from(text).length < 0.35
}

function isShortStandaloneLabel(text: string): boolean {
  const semanticChars = semanticCharCount(text)
  if (semanticChars <= 2) return true
  if (hasWordBoundary(text)) return false
  if (digitCount(text) > 0) return false
  return semanticChars <= 6
}

function isLikelyClockOrCounter(text: string): boolean {
  if (/^\d{1,2}:\d{2}(?::\d{2})?\s?(AM|PM)?$/iu.test(text)) return true
  const letters = letterCount(text)
  const digits = digitCount(text)
  return digits > 0 && digits >= letters && semanticCharCount(text) <= 8
}

function isLikelyNoiseLine(text: string): boolean {
  if (isMostlySymbols(text)) return true
  if (isLikelyClockOrCounter(text)) return true
  if (isShortStandaloneLabel(text)) return true
  return false
}

function normalizeUrlLine(text: string): string | null {
  if (!/^https?:\/\//iu.test(text)) return text
  try {
    return new URL(text).hostname
  } catch {
    return null
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value
}

export function cleanActivityOcrLines(
  input: CleanActivityOcrLinesInput
): ActivityOcrSnapshot | null {
  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const minTextChars = input.minTextChars ?? DEFAULT_MIN_TEXT_CHARS
  const maxTextChars = input.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
  const maxExcerptChars = input.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS
  const seen = new Set<string>()
  const lines: ActivityOcrLineInput[] = []

  for (const line of input.lines) {
    if (line.confidence < minConfidence) continue
    const normalized = normalizeLine(line.text)
    if (!normalized) continue
    if (isLikelyNoiseLine(normalized)) continue

    const urlNormalized = normalizeUrlLine(normalized)
    if (!urlNormalized) continue
    if (semanticCharCount(urlNormalized) < 3) continue

    const key = urlNormalized.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    lines.push({ text: urlNormalized, confidence: line.confidence })
  }

  const fullText = lines.map((line) => line.text).join('\n')
  const compactText = fullText.replace(/\s+/gu, '')
  if (semanticCharCount(compactText) < minTextChars) return null

  const text = truncate(fullText, maxTextChars)
  const excerpt = truncate(text.replace(/\s+/gu, ' ').trim(), maxExcerptChars)
  const confidence =
    Math.round((lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length) * 100) / 100
  const contentHash = `sha256:${createHash('sha256').update(text).digest('hex')}`

  return {
    engine: 'apple-vision',
    revision: 3,
    confidence,
    lineCount: lines.length,
    contentHash,
    excerpt,
    text
  }
}
