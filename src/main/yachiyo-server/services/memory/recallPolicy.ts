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

const GROWTH_MESSAGE_THRESHOLD = 4
const GROWTH_CHAR_THRESHOLD = 4096
const IDLE_RECALL_MS = 1000 * 60 * 60 * 6
const RECENT_INJECTION_MESSAGE_WINDOW = 4
const RECENT_INJECTION_CHAR_WINDOW = 900
const RECENT_INJECTION_SCORE_BOOST = 0.22
const MAX_RECENT_INJECTIONS = 16
const MAX_NOVEL_TERMS = 6
const RECENT_CONTEXT_MESSAGE_LIMIT = 6
const WORD_SEGMENTER = new Intl.Segmenter('zh-Hans', { granularity: 'word' })
const CLAUSE_SPLIT_PATTERN = /[\n\r,，.。!！?？:：;；、()（）【】[\]{}"'`]+/u

interface TopicToken {
  value: string
  hasLatinOrDigit: boolean
}

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

function isWordLikeToken(value: string): boolean {
  return /[\p{Letter}\p{Number}\u3400-\u9fff]/u.test(value)
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[^\p{Letter}\p{Number}\u3400-\u9fff]+|[^\p{Letter}\p{Number}\u3400-\u9fff]+$/gu, '')
}

function extractTopicTokens(value: string): TopicToken[] {
  const tokens: TopicToken[] = []

  for (const { segment, isWordLike } of WORD_SEGMENTER.segment(value)) {
    if (!isWordLike && !isWordLikeToken(segment)) {
      continue
    }

    const normalized = normalizeToken(segment)
    if (normalized.length < 2) {
      continue
    }

    tokens.push({
      value: normalized,
      hasLatinOrDigit: /[a-z0-9]/u.test(normalized)
    })
  }

  return tokens
}

function splitClauses(value: string): string[] {
  return value
    .split(CLAUSE_SPLIT_PATTERN)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function clauseHasSignal(tokens: TopicToken[]): boolean {
  if (tokens.length === 0) {
    return false
  }

  if (tokens.some((token) => token.hasLatinOrDigit)) {
    return true
  }

  const maxTokenLength = Math.max(...tokens.map((token) => token.value.length))
  const totalLength = tokens.reduce((sum, token) => sum + token.value.length, 0)

  return maxTokenLength >= 4 || totalLength >= 8 || tokens.length >= 4
}

function joinPhraseTokens(tokens: TopicToken[]): string {
  return tokens.every((token) => !token.hasLatinOrDigit)
    ? tokens.map((token) => token.value).join('')
    : tokens.map((token) => token.value).join(' ')
}

function buildTopicCandidates(value: string): string[] {
  const candidates: string[] = []

  for (const clause of splitClauses(value)) {
    const tokens = extractTopicTokens(clause)
    if (!clauseHasSignal(tokens)) {
      continue
    }

    for (let index = 0; index < tokens.length; index += 1) {
      const single = tokens[index]
      if (!single) {
        continue
      }

      if (single.hasLatinOrDigit || single.value.length >= 4) {
        candidates.push(single.value)
      }

      for (let span = 2; span <= 3; span += 1) {
        const slice = tokens.slice(index, index + span)
        if (slice.length < span) {
          continue
        }

        const totalLength = slice.reduce((sum, token) => sum + token.value.length, 0)
        const longestTokenLength = Math.max(...slice.map((token) => token.value.length))
        if (
          totalLength < 5 ||
          (longestTokenLength < 3 && !slice.some((token) => token.hasLatinOrDigit))
        ) {
          continue
        }

        candidates.push(joinPhraseTokens(slice))
      }
    }
  }

  return candidates
}

function uniqueTerms(value: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []

  for (const term of buildTopicCandidates(value)) {
    if (seen.has(term)) {
      continue
    }

    seen.add(term)
    terms.push(term)
  }

  return terms
}

function scoreTerm(term: string): number {
  const latinBoost = /[a-z0-9]/u.test(term) ? 2 : 0
  const phraseBoost = /\s/u.test(term) || term.length >= 5 ? 1.5 : 0
  return term.length + latinBoost + phraseBoost
}

function filterOverlappingTerms(terms: string[]): string[] {
  const kept: string[] = []

  for (const term of terms) {
    if (kept.some((existing) => existing.includes(term) || term.includes(existing))) {
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
  const normalizedQuery = normalizeText(input.userQuery)
  if (!normalizedQuery) {
    return { noveltyScore: 0, novelTerms: [] }
  }

  const contextWindow = input.history
    .slice(0, -1)
    .slice(-RECENT_CONTEXT_MESSAGE_LIMIT)
    .map((message) => message.content)
    .join('\n')
  const contextTerms = new Set(uniqueTerms(normalizeText(contextWindow)))
  const queryTerms = uniqueTerms(normalizedQuery)

  if (queryTerms.length === 0) {
    return { noveltyScore: 0, novelTerms: [] }
  }

  const novelTerms = filterOverlappingTerms(
    queryTerms
      .filter((term) => !contextTerms.has(term))
      .sort((left, right) => scoreTerm(right) - scoreTerm(left))
  ).slice(0, MAX_NOVEL_TERMS)
  const noveltyScore = Math.min(1, novelTerms.length / Math.max(2, Math.min(queryTerms.length, 6)))

  return {
    noveltyScore,
    novelTerms
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

  if (novelty.noveltyScore >= 0.62 && novelty.novelTerms.length >= 2) {
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
