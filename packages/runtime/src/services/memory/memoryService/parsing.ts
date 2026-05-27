import type { MemoryCandidate, MemoryQueryPlanResult, MemoryUnitType } from '../memoryService.ts'

interface QueryPlanEnvelope {
  skip?: boolean
  skipReason?: string
  queries?: Array<{
    query?: unknown
    topic?: unknown
    reason?: unknown
    weight?: unknown
  }>
}

interface CandidateEnvelope {
  candidates?: Array<{
    topic?: unknown
    content?: unknown
    importance?: unknown
    title?: unknown
    unitType?: unknown
  }>
}

const MEMORY_UNIT_TYPES: readonly MemoryUnitType[] = [
  'fact',
  'preference',
  'decision',
  'plan',
  'procedure',
  'learning',
  'context',
  'event'
]
const FORBIDDEN_MEMORY_PHRASES = [
  /\bthis time\b/iu,
  /\bjust now\b/iu,
  /\bcurrently\b/iu,
  /\bwe discussed\b/iu,
  /\bwe talked about\b/iu,
  /\bin this (chat|conversation|thread|run)\b/iu,
  /\bearlier (today|in this chat|in this thread)\b/iu,
  /\bit seems\b/iu,
  /\bmaybe\b/iu,
  /\bseems like\b/iu,
  /\bthe user asked\b/iu,
  /\bthe assistant said\b/iu,
  /这次/u,
  /刚才/u,
  /目前/u,
  /我们讨论/u,
  /这段对话/u,
  /这个线程/u,
  /似乎/u,
  /也许/u
]
const FORBIDDEN_MEMORY_TITLE_PATTERNS = [
  /^(i|we|you)\b/iu,
  /^(this|that|these|those)\b/iu,
  /^(discussion|conversation)\b/iu
]
const FORBIDDEN_MEMORY_CONTENT_PATTERNS = [
  /\b(asked|said|mentioned|talked about|discussed)\b/iu,
  /\bconversation\b/iu,
  /用户/u,
  /助手/u,
  /对话/u
]
const MAX_MEMORY_TITLE_LENGTH = 80
const MAX_MEMORY_CONTENT_LENGTH = 320
const MAX_MEMORY_TOPIC_LENGTH = 64
const MIN_MEMORY_CONTENT_LENGTH = 20
const MIN_MEMORY_TITLE_LENGTH = 3
const MIN_MEMORY_TOPIC_LENGTH = 3
const MIN_IMPORTANCE_THRESHOLD = 0.6
const DEFAULT_MEMORY_TOOL_LIMIT = 5
const MEMORY_QUERY_MAX_CHARS = 2000

export function filterByImportance(candidates: MemoryCandidate[]): MemoryCandidate[] {
  return candidates.filter(
    (c) => c.importance === undefined || c.importance >= MIN_IMPORTANCE_THRESHOLD
  )
}

function clampWeight(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined
  }

  return Math.max(0, Math.min(1, value))
}

export function normalizeTopicKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-+/gu, '-')
    .slice(0, MAX_MEMORY_TOPIC_LENGTH)
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function sanitizeMemoryQueryText(
  raw: string,
  maxChars: number = MEMORY_QUERY_MAX_CHARS
): string {
  if (!raw) return ''
  const stripped = raw
    .replace(/<file_mentions>[\s\S]*?<\/file_mentions>/gu, '')
    .replace(/<referenced_file[^>]*>[\s\S]*?<\/referenced_file>/gu, '')
    .replace(/<referenced_directory[^>]*>[\s\S]*?<\/referenced_directory>/gu, '')
    .replace(/<referenced_jotdown[^>]*>[\s\S]*?<\/referenced_jotdown>/gu, '')
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/gu, '')
  const normalized = normalizeWhitespace(stripped)
  return normalized.length > maxChars ? normalized.slice(0, maxChars) : normalized
}

export function clampMemorySearchLimit(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_MEMORY_TOOL_LIMIT
  }

  return Math.max(1, Math.min(10, Math.trunc(value)))
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function stripMarkdownFence(value: string): string {
  const fenced = value.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u)
  return fenced?.[1]?.trim() ?? value.trim()
}

function hasForbiddenMemoryPhrase(value: string): boolean {
  return FORBIDDEN_MEMORY_PHRASES.some((pattern) => pattern.test(value))
}

function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value))
}

function normalizeUnitType(value: unknown): MemoryUnitType {
  return MEMORY_UNIT_TYPES.includes(value as MemoryUnitType) ? (value as MemoryUnitType) : 'fact'
}

export function humanizeTopic(topic: string): string {
  return topic
    .split('-')
    .filter(Boolean)
    .map((segment) =>
      segment.length <= 3
        ? segment.toUpperCase()
        : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`
    )
    .join(' ')
}

function extractJsonBlock(value: string): string | null {
  const unfenced = stripMarkdownFence(value)
  const objectStart = unfenced.indexOf('{')
  const arrayStart = unfenced.indexOf('[')
  const start =
    objectStart === -1
      ? arrayStart
      : arrayStart === -1
        ? objectStart
        : Math.min(objectStart, arrayStart)

  if (start === -1) {
    return null
  }

  const objectEnd = unfenced.lastIndexOf('}')
  const arrayEnd = unfenced.lastIndexOf(']')
  const end = Math.max(objectEnd, arrayEnd)

  if (end < start) {
    return null
  }

  return unfenced.slice(start, end + 1)
}

function parseJsonEnvelope<T>(value: string): T | null {
  const jsonBlock = extractJsonBlock(value)
  if (!jsonBlock) {
    return null
  }

  try {
    return JSON.parse(jsonBlock) as T
  } catch {
    return null
  }
}

export function parseQueryPlan(text: string): MemoryQueryPlanResult {
  const parsed = parseJsonEnvelope<QueryPlanEnvelope>(text)
  if (!parsed) {
    return { skip: false, queries: [] }
  }

  if (parsed.skip === true) {
    return {
      skip: true,
      skipReason:
        typeof parsed.skipReason === 'string' ? normalizeWhitespace(parsed.skipReason) : undefined,
      queries: []
    }
  }

  if (!parsed.queries || !Array.isArray(parsed.queries)) {
    return { skip: false, queries: [] }
  }

  const queries = parsed.queries
    .flatMap((item) => {
      const query = typeof item.query === 'string' ? normalizeWhitespace(item.query) : ''
      if (!query) {
        return []
      }

      return [
        {
          query,
          topic:
            typeof item.topic === 'string'
              ? normalizeTopicKey(normalizeWhitespace(item.topic))
              : undefined,
          reason: typeof item.reason === 'string' ? normalizeWhitespace(item.reason) : undefined,
          weight: clampWeight(item.weight)
        }
      ]
    })
    .slice(0, 3)

  return { skip: false, queries }
}

export function normalizeMemoryCandidate(raw: {
  content?: unknown
  importance?: unknown
  title?: unknown
  topic?: unknown
  unitType?: unknown
}): MemoryCandidate | null {
  const rawTopic = typeof raw.topic === 'string' ? normalizeWhitespace(raw.topic) : ''
  const rawTitle = typeof raw.title === 'string' ? normalizeWhitespace(raw.title) : ''
  const rawContent = typeof raw.content === 'string' ? normalizeWhitespace(raw.content) : ''

  const topic = normalizeTopicKey(rawTopic || rawTitle)
  const title = truncate(
    rawTitle.replace(/[.!?。！？:：]+$/u, '').trim() || humanizeTopic(topic),
    MAX_MEMORY_TITLE_LENGTH
  )
  const content = truncate(rawContent.replace(/^[-*]\s*/u, '').trim(), MAX_MEMORY_CONTENT_LENGTH)

  if (!topic || !title || !content) {
    return null
  }

  if (
    topic.length < MIN_MEMORY_TOPIC_LENGTH ||
    title.length < MIN_MEMORY_TITLE_LENGTH ||
    content.length < MIN_MEMORY_CONTENT_LENGTH
  ) {
    return null
  }

  if (title.includes('\n') || content.includes('\n')) {
    return null
  }

  if (
    hasForbiddenMemoryPhrase(title) ||
    hasForbiddenMemoryPhrase(content) ||
    matchesAnyPattern(title, FORBIDDEN_MEMORY_TITLE_PATTERNS) ||
    matchesAnyPattern(content, FORBIDDEN_MEMORY_CONTENT_PATTERNS)
  ) {
    return null
  }

  return {
    topic,
    title,
    content,
    importance: clampWeight(raw.importance),
    unitType: normalizeUnitType(raw.unitType)
  }
}

export function describeMemoryRejection(raw: {
  content?: unknown
  importance?: unknown
  title?: unknown
  topic?: unknown
  unitType?: unknown
}): string {
  const rawTitle = typeof raw.title === 'string' ? normalizeWhitespace(raw.title) : ''
  const rawContent = typeof raw.content === 'string' ? normalizeWhitespace(raw.content) : ''
  const rawTopic = typeof raw.topic === 'string' ? normalizeWhitespace(raw.topic) : ''

  const topic = normalizeTopicKey(rawTopic || rawTitle)
  const title = rawTitle.replace(/[.!?。！？:：]+$/u, '').trim() || humanizeTopic(topic)
  const content = rawContent.replace(/^[-*]\s*/u, '').trim()

  if (!topic || topic.length < MIN_MEMORY_TOPIC_LENGTH) {
    return `Topic is too short (min ${MIN_MEMORY_TOPIC_LENGTH} chars). Provide a meaningful title or topic.`
  }
  if (!title || title.length < MIN_MEMORY_TITLE_LENGTH) {
    return `Title is too short (min ${MIN_MEMORY_TITLE_LENGTH} chars).`
  }
  if (!content || content.length < MIN_MEMORY_CONTENT_LENGTH) {
    return `Content is too short (min ${MIN_MEMORY_CONTENT_LENGTH} chars). Write a self-contained statement.`
  }
  if (title.includes('\n') || content.includes('\n')) {
    return 'Title and content must be single-line (no newlines).'
  }
  if (hasForbiddenMemoryPhrase(title) || hasForbiddenMemoryPhrase(content)) {
    return 'Memory contains forbidden temporal or conversational phrases (e.g. "this time", "we discussed", "currently"). Rewrite as a timeless observation.'
  }
  if (matchesAnyPattern(title, FORBIDDEN_MEMORY_TITLE_PATTERNS)) {
    return 'Title must not start with pronouns (I/we/you), demonstratives (this/that), or meta-labels (discussion/conversation).'
  }
  if (matchesAnyPattern(content, FORBIDDEN_MEMORY_CONTENT_PATTERNS)) {
    return 'Content must not reference conversation roles (asked/said/mentioned/discussed/conversation).'
  }
  return 'Memory rejected by validation. Rewrite as a durable, timeless observation.'
}

export function buildTopicLabel(topic: string): string {
  return `topic:${topic}`
}

export function chooseBetterContent(left: string, right: string): string {
  if (left === right) {
    return left
  }

  return right.length > left.length ? right : left
}

function mergeCandidatePair(left: MemoryCandidate, right: MemoryCandidate): MemoryCandidate {
  return {
    topic: left.topic,
    title: left.title.length <= right.title.length ? left.title : right.title,
    content: chooseBetterContent(left.content, right.content),
    importance: Math.max(left.importance ?? 0, right.importance ?? 0) || undefined,
    unitType: left.unitType === right.unitType ? left.unitType : right.unitType
  }
}

export function mergeCandidatesByTopic(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const merged = new Map<string, MemoryCandidate>()

  for (const candidate of candidates) {
    const existing = merged.get(candidate.topic)
    merged.set(candidate.topic, existing ? mergeCandidatePair(existing, candidate) : candidate)
  }

  return [...merged.values()]
}

export function parseMemoryCandidates(text: string): MemoryCandidate[] {
  const parsed = parseJsonEnvelope<CandidateEnvelope>(text)
  if (!parsed?.candidates || !Array.isArray(parsed.candidates)) {
    return []
  }

  return mergeCandidatesByTopic(
    parsed.candidates
      .map((item) => normalizeMemoryCandidate(item))
      .filter((item): item is MemoryCandidate => item !== null)
      .slice(0, 8)
  )
}

export function normalizeDedupKey(input: { title: string; content: string }): string {
  return `${input.title}\n${input.content}`
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, ' ')
    .trim()
}

function tokenizeForSimilarity(value: string): string[] {
  return normalizeDedupKey({ title: value, content: '' })
    .split(/\s+/u)
    .filter((token) => token.length > 1)
}

export function computeTokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokenizeForSimilarity(left))
  const rightTokens = new Set(tokenizeForSimilarity(right))

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0
  }

  let shared = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1
    }
  }

  return shared / Math.max(leftTokens.size, rightTokens.size)
}
