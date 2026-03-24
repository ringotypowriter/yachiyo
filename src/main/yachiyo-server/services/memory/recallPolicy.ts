import type {
  MessageRecord,
  RecallDecisionSnapshot,
  ThreadMemoryRecallEntry,
  ThreadMemoryRecallState,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'

export interface RecallThreadMetrics {
  messageCount: number
  charCount: number
}

export interface RecallNoveltySignal {
  noveltyScore: number
  novelTerms: string[]
}

export interface RecallDecisionInput {
  history: MessageRecord[]
  now: string
  novelty?: RecallNoveltySignal
  thread: ThreadRecord
  userQuery: string
}

export interface RecallFilterCandidate {
  entry: string
  id: string
  score: number
}

export interface RecallFilterInput {
  candidates: RecallFilterCandidate[]
  history: MessageRecord[]
  now: string
  thread: ThreadRecord
  userQuery: string
}

export interface RecallFilterResult {
  entries: string[]
  recentInjections: ThreadMemoryRecallEntry[]
}

const GROWTH_MESSAGE_THRESHOLD = 6
const GROWTH_CHAR_THRESHOLD = 4096
const IDLE_RECALL_MS = 1000 * 60 * 60 * 6
const RECENT_INJECTION_MESSAGE_WINDOW = 4
const RECENT_INJECTION_CHAR_WINDOW = 900
const RECENT_INJECTION_SCORE_BOOST = 0.22
const MAX_RECENT_INJECTIONS = 16
const MAX_NOVEL_TERMS = 6
const RECENT_CONTEXT_MESSAGE_LIMIT = 6
const NOVELTY_SCORE_THRESHOLD = 0.75
const NOVELTY_TERM_THRESHOLD = 3
const MAX_MARKED_TERM_LENGTH = 64
const MIN_UNMARKED_CJK_TERM_LENGTH = 3
const MAX_UNMARKED_CJK_TERM_LENGTH = 8
const MARKER_TERM_SCORE = 1
const MARKER_CJK_TERM_SCORE = 0.58
const SYNTAX_TERM_SCORE = 0.88
const CODE_SWITCH_TERM_SCORE = 0.74
const PURE_CJK_TERM_SCORE_CAP = 0.18
const MIN_EXTRACTABLE_TERM_SCORE = 0.2
const CJK_PATTERN = /[\u3400-\u9fff]/u
const ALLOWED_TERM_CHARS_PATTERN = /[^\p{Letter}\p{Number}\u3400-\u9fff._/-]+/gu
const STRUCTURAL_SPLIT_PATTERN = /[\s\n\r,，.。!！?？:：;；、()（）【】[\]{}"'“”‘’`*]+/u

interface NovelTermCandidate {
  normalized: string
  order: number
  score: number
}

const EMPHASIZED_TERM_PATTERNS = [
  /`([^`\n]{2,64})`/gu,
  /\*\*([^*\n]{2,64})\*\*/gu,
  /(?<!\*)\*([^*\n]{2,64})\*(?!\*)/gu,
  /"([^"\n]{2,64})"/gu,
  /“([^”\n]{2,64})”/gu,
  /\[([^\]\n]{2,64})\]/gu,
  /【([^】\n]{2,64})】/gu,
  /「([^」\n]{2,64})」/gu
] as const

const SYNTAX_TERM_PATTERNS = [
  /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/gu,
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/gu,
  /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/giu,
  /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/giu,
  /\b(?:[A-Za-z]+[-_.]?\d[\w.-]*|[A-Za-z]*\d+[A-Za-z][\w.-]*)\b/gu
] as const

const LATIN_TERM_PATTERN = /\b[A-Za-z][A-Za-z0-9]{1,}\b/gu

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

function countChars(history: MessageRecord[]): number {
  return history.reduce((total, message) => total + message.content.length, 0)
}

export function buildRecallThreadMetrics(history: MessageRecord[]): RecallThreadMetrics {
  return {
    messageCount: history.length,
    charCount: countChars(history)
  }
}

function normalizeNovelTerm(value: string): string {
  return normalizeText(value).replace(ALLOWED_TERM_CHARS_PATTERN, ' ').replace(/\s+/gu, ' ').trim()
}

function isPureCjkTerm(value: string): boolean {
  return /^[\u3400-\u9fff]+$/u.test(value)
}

function isSyntaxTerm(value: string): boolean {
  return SYNTAX_TERM_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(value)
  })
}

function isLatinCodeSwitchTerm(value: string): boolean {
  return /^[a-z0-9]+$/u.test(value) && value.length >= 3
}

function addNovelTermCandidate(
  candidates: Map<string, NovelTermCandidate>,
  rawValue: string,
  score: number,
  orderRef: { value: number }
): void {
  const normalized = normalizeNovelTerm(rawValue)
  if (!normalized || normalized.length > MAX_MARKED_TERM_LENGTH) {
    return
  }

  const existing = candidates.get(normalized)
  if (!existing) {
    candidates.set(normalized, {
      normalized,
      order: orderRef.value,
      score
    })
    orderRef.value += 1
    return
  }

  if (score > existing.score) {
    existing.score = score
  }
}

function extractMarkedTermCandidates(
  value: string,
  candidates: Map<string, NovelTermCandidate>,
  orderRef: { value: number }
): void {
  for (const pattern of EMPHASIZED_TERM_PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      const raw = match[1]?.trim()
      if (!raw) {
        continue
      }

      const normalized = normalizeNovelTerm(raw)
      if (!normalized) {
        continue
      }

      addNovelTermCandidate(
        candidates,
        normalized,
        isPureCjkTerm(normalized) ? MARKER_CJK_TERM_SCORE : MARKER_TERM_SCORE,
        orderRef
      )
    }
  }
}

function extractSyntaxTermCandidates(
  value: string,
  candidates: Map<string, NovelTermCandidate>,
  orderRef: { value: number }
): void {
  for (const pattern of SYNTAX_TERM_PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      const raw = match[0]?.trim()
      if (!raw) {
        continue
      }

      addNovelTermCandidate(candidates, raw, SYNTAX_TERM_SCORE, orderRef)
    }
  }
}

function extractLatinCodeSwitchCandidates(
  value: string,
  candidates: Map<string, NovelTermCandidate>,
  orderRef: { value: number }
): void {
  if (!CJK_PATTERN.test(value)) {
    return
  }

  for (const match of value.matchAll(LATIN_TERM_PATTERN)) {
    const raw = match[0]?.trim()
    if (!raw || isSyntaxTerm(raw)) {
      continue
    }

    const normalized = normalizeNovelTerm(raw)
    if (!isLatinCodeSwitchTerm(normalized)) {
      continue
    }

    addNovelTermCandidate(candidates, normalized, CODE_SWITCH_TERM_SCORE, orderRef)
  }
}

function extractPureCjkCandidates(
  value: string,
  candidates: Map<string, NovelTermCandidate>,
  orderRef: { value: number }
): void {
  for (const fragment of value.split(STRUCTURAL_SPLIT_PATTERN)) {
    const normalized = normalizeNovelTerm(fragment)
    if (
      !normalized ||
      !isPureCjkTerm(normalized) ||
      normalized.length < MIN_UNMARKED_CJK_TERM_LENGTH ||
      normalized.length > MAX_UNMARKED_CJK_TERM_LENGTH
    ) {
      continue
    }

    addNovelTermCandidate(candidates, normalized, PURE_CJK_TERM_SCORE_CAP, orderRef)
  }
}

function extractNovelTermCandidates(value: string): NovelTermCandidate[] {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return []
  }

  const candidates = new Map<string, NovelTermCandidate>()
  const orderRef = { value: 0 }

  extractMarkedTermCandidates(normalizedValue, candidates, orderRef)
  extractSyntaxTermCandidates(normalizedValue, candidates, orderRef)
  extractLatinCodeSwitchCandidates(normalizedValue, candidates, orderRef)
  extractPureCjkCandidates(normalizedValue, candidates, orderRef)

  return [...candidates.values()]
    .filter((candidate) => candidate.score >= MIN_EXTRACTABLE_TERM_SCORE)
    .sort((left, right) => right.score - left.score || left.order - right.order)
}

function filterOverlappingTerms(terms: NovelTermCandidate[]): NovelTermCandidate[] {
  const kept: NovelTermCandidate[] = []

  for (const term of terms) {
    if (
      kept.some(
        (existing) =>
          existing.normalized.includes(term.normalized) ||
          term.normalized.includes(existing.normalized)
      )
    ) {
      continue
    }

    kept.push(term)
  }

  return kept
}

export function detectNoveltySignal(input: {
  history: MessageRecord[]
  userQuery: string
}): RecallNoveltySignal {
  if (!normalizeText(input.userQuery)) {
    return { noveltyScore: 0, novelTerms: [] }
  }

  const contextWindow = input.history
    .slice(0, -1)
    .slice(-RECENT_CONTEXT_MESSAGE_LIMIT)
    .map((message) => message.content)
    .join('\n')
  const contextTerms = new Set(
    extractNovelTermCandidates(contextWindow).map((candidate) => candidate.normalized)
  )
  const queryTerms = extractNovelTermCandidates(input.userQuery)

  if (queryTerms.length === 0) {
    return { noveltyScore: 0, novelTerms: [] }
  }

  const novelTerms = filterOverlappingTerms(
    queryTerms.filter((term) => !contextTerms.has(term.normalized))
  ).slice(0, MAX_NOVEL_TERMS)
  const noveltyScore =
    novelTerms
      .slice(0, NOVELTY_TERM_THRESHOLD)
      .reduce((total, candidate) => total + candidate.score, 0) / NOVELTY_TERM_THRESHOLD

  return {
    noveltyScore: Number(Math.min(1, noveltyScore).toFixed(3)),
    novelTerms: novelTerms.map((candidate) => candidate.normalized)
  }
}

function parseTimestamp(value?: string): number | null {
  if (!value) {
    return null
  }

  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function isColdStartThread(input: { history: MessageRecord[]; thread: ThreadRecord }): boolean {
  const state = input.thread.memoryRecall
  if (state?.lastRunAt || state?.lastRecallAt) {
    return false
  }

  return input.history.length <= 1 || Boolean(input.thread.branchFromThreadId)
}

export function shouldRecallBeforeRun(input: RecallDecisionInput): RecallDecisionSnapshot {
  const metrics = buildRecallThreadMetrics(input.history)
  const novelty =
    input.novelty ??
    detectNoveltySignal({
      history: input.history,
      userQuery: input.userQuery
    })
  const state = input.thread.memoryRecall
  const messagesSinceLastRecall = Math.max(
    0,
    metrics.messageCount - (state?.lastRecallMessageCount ?? 0)
  )
  const charsSinceLastRecall = Math.max(0, metrics.charCount - (state?.lastRecallCharCount ?? 0))
  const lastActivityMs = Math.max(
    parseTimestamp(state?.lastRunAt) ?? 0,
    parseTimestamp(state?.lastRecallAt) ?? 0
  )
  const idleMs = Math.max(0, (parseTimestamp(input.now) ?? 0) - lastActivityMs)
  const reasons: string[] = []
  let score = 0

  if (isColdStartThread(input)) {
    reasons.push('thread-cold-start')
    return {
      shouldRecall: true,
      score: 1,
      reasons,
      messagesSinceLastRecall,
      charsSinceLastRecall,
      idleMs,
      noveltyScore: novelty.noveltyScore,
      novelTerms: novelty.novelTerms
    }
  }

  if (messagesSinceLastRecall >= GROWTH_MESSAGE_THRESHOLD) {
    reasons.push('message-growth')
    score += 0.6
  }

  if (charsSinceLastRecall >= GROWTH_CHAR_THRESHOLD) {
    reasons.push('char-growth')
    score += 0.6
  }

  if (lastActivityMs > 0 && idleMs >= IDLE_RECALL_MS) {
    reasons.push('idle-gap')
    score += 0.7
  }

  if (
    novelty.noveltyScore >= NOVELTY_SCORE_THRESHOLD &&
    novelty.novelTerms.length >= NOVELTY_TERM_THRESHOLD
  ) {
    reasons.push('topic-novelty')
    score += 0.65
  }

  return {
    shouldRecall: reasons.length > 0,
    score: Number(score.toFixed(3)),
    reasons,
    messagesSinceLastRecall,
    charsSinceLastRecall,
    idleMs,
    noveltyScore: Number(novelty.noveltyScore.toFixed(3)),
    novelTerms: novelty.novelTerms
  }
}

export function buildMemoryFingerprint(input: { entry: string; id: string }): string {
  const normalized = `${input.id}\n${input.entry}`
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, ' ')
    .trim()

  return normalized || input.id
}

function pruneRecentInjections(
  entries: ThreadMemoryRecallEntry[],
  metrics: RecallThreadMetrics
): ThreadMemoryRecallEntry[] {
  return entries
    .filter(
      (entry) =>
        metrics.messageCount - entry.messageCount <= RECENT_INJECTION_MESSAGE_WINDOW * 4 &&
        metrics.charCount - entry.charCount <= RECENT_INJECTION_CHAR_WINDOW * 4
    )
    .slice(-MAX_RECENT_INJECTIONS)
}

export function filterRecalledMemories(input: RecallFilterInput): RecallFilterResult {
  const metrics = buildRecallThreadMetrics(input.history)
  const previousInjections = input.thread.memoryRecall?.recentInjections ?? []
  const nextInjections = [...pruneRecentInjections(previousInjections, metrics)]
  const entries: string[] = []

  for (const candidate of input.candidates) {
    const fingerprint = buildMemoryFingerprint(candidate)
    const previous = [...previousInjections]
      .reverse()
      .find(
        (entry) =>
          entry.memoryId === candidate.id ||
          (entry.fingerprint.length > 0 && entry.fingerprint === fingerprint)
      )

    const messageDistance = previous ? metrics.messageCount - previous.messageCount : Infinity
    const charDistance = previous ? metrics.charCount - previous.charCount : Infinity
    const recentlyInjected =
      messageDistance <= RECENT_INJECTION_MESSAGE_WINDOW &&
      charDistance <= RECENT_INJECTION_CHAR_WINDOW &&
      candidate.score < (previous?.score ?? 0) + RECENT_INJECTION_SCORE_BOOST

    if (recentlyInjected) {
      continue
    }

    entries.push(candidate.entry)
    nextInjections.push({
      memoryId: candidate.id,
      fingerprint,
      injectedAt: input.now,
      messageCount: metrics.messageCount,
      charCount: metrics.charCount,
      ...(candidate.score > 0 ? { score: candidate.score } : {})
    })
  }

  return {
    entries,
    recentInjections: nextInjections.slice(-MAX_RECENT_INJECTIONS)
  }
}

export function buildNextRecallState(input: {
  didRecall?: boolean
  decision: RecallDecisionSnapshot
  history: MessageRecord[]
  now: string
  recentInjections?: ThreadMemoryRecallEntry[]
  thread: ThreadRecord
}): ThreadMemoryRecallState {
  const metrics = buildRecallThreadMetrics(input.history)
  const current = input.thread.memoryRecall
  const didRecall = input.didRecall ?? input.decision.shouldRecall

  return {
    ...(input.now.trim() ? { lastRunAt: input.now } : {}),
    ...(didRecall
      ? { lastRecallAt: input.now }
      : current?.lastRecallAt
        ? { lastRecallAt: current.lastRecallAt }
        : {}),
    ...(didRecall
      ? { lastRecallMessageCount: metrics.messageCount }
      : typeof current?.lastRecallMessageCount === 'number'
        ? { lastRecallMessageCount: current.lastRecallMessageCount }
        : {}),
    ...(didRecall
      ? { lastRecallCharCount: metrics.charCount }
      : typeof current?.lastRecallCharCount === 'number'
        ? { lastRecallCharCount: current.lastRecallCharCount }
        : {}),
    ...(input.recentInjections && input.recentInjections.length > 0
      ? { recentInjections: input.recentInjections }
      : current?.recentInjections?.length
        ? { recentInjections: current.recentInjections }
        : {})
  }
}
