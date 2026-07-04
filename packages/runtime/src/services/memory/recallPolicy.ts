import nlp from 'compromise'
import * as stopword from 'stopword'

// jieba-wasm compiles its WebAssembly at module evaluation, which is too heavy
// for the synchronous startup path (this module is statically reachable from
// YachiyoServer). Load it in the background and degrade CJK segmentation to
// "no novelty terms" for the brief window before it arrives.
type JiebaTag = (text: string, hmm: boolean) => Array<{ word: string; tag: string }>
let jiebaTag: JiebaTag | null = null
const jiebaReady: Promise<void> = import('jieba-wasm')
  .then((module) => {
    jiebaTag = module.tag as JiebaTag
  })
  .catch((error) => {
    console.warn('[memory] jieba segmenter failed to load; CJK novelty terms disabled', error)
  })

/** Resolves once the CJK segmenter is available (used by tests for determinism). */
export function whenRecallSegmenterReady(): Promise<void> {
  return jiebaReady
}

import type {
  MessageRecord,
  RecallDecisionSnapshot,
  ThreadMemoryRecallEntry,
  ThreadMemoryRecallState,
  ThreadRecord
} from '@yachiyo/shared/protocol'

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

const RECENT_INJECTION_MESSAGE_WINDOW = 4
const RECENT_INJECTION_CHAR_WINDOW = 900
const RECENT_INJECTION_SCORE_BOOST = 0.22
const MAX_RECENT_INJECTIONS = 16
const MAX_NOVEL_TERMS = 8
const RECENT_CONTEXT_MESSAGE_LIMIT = 8
const NOVELTY_SCORE_THRESHOLD = 0.7
const NOVELTY_TERM_THRESHOLD = 3
const MAX_MARKED_TERM_LENGTH = 64
const MIN_NOVEL_TERM_STRENGTH = 0.35
const MARKER_TERM_SCORE = 1
const MARKER_CJK_TERM_SCORE = 0.92
const SYNTAX_TERM_SCORE = 0.96
const PHRASE_TERM_SCORE = 0.82
const CJK_BIGRAM_TERM_SCORE = 0.55
const MIN_EXTRACTABLE_TERM_SCORE = 0.3
const CJK_PATTERN = /[\u3400-\u9fff]/u
const PURE_CJK_PATTERN = /^[\u3400-\u9fff]+$/u
const ALLOWED_TERM_CHARS_PATTERN = /[^\p{Letter}\p{Number}\u3400-\u9fff._/-]+/gu
const STRUCTURAL_SPLIT_PATTERN = /[\n\r,，.。!！?？:：;；、()（）【】[\]{}"'“”‘’`*]+/u

interface TaggedWord {
  normalized: string
  tag: string
}

interface NovelTermCandidate {
  count: number
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
  /\b[A-Z][A-Z0-9]{1,}\b/gu,
  /\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/gu,
  /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/gu,
  /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/giu,
  /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/giu,
  /\b(?:[A-Za-z]+[-_.]?\d[\w.-]*|[A-Za-z]*\d+[A-Za-z][\w.-]*)\b/gu
] as const

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
  return PURE_CJK_PATTERN.test(value)
}

function isPhraseWord(value: string): boolean {
  if (!value || value.length > MAX_MARKED_TERM_LENGTH) {
    return false
  }

  if (/^\p{Number}+$/u.test(value)) {
    return false
  }

  if (isPureCjkTerm(value)) {
    return value.length >= 2
  }

  return /^[\p{Letter}][\p{Letter}\p{Number}_/-]*$/u.test(value) && value.length >= 3
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
      count: 1,
      normalized,
      order: orderRef.value,
      score
    })
    orderRef.value += 1
    return
  }

  existing.count += 1
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

function segmentCjkWordGroups(value: string): TaggedWord[][] {
  if (!jiebaTag) return []
  const groups: TaggedWord[][] = []
  let current: TaggedWord[] = []

  for (const word of jiebaTag(value, true)) {
    const normalized = normalizeNovelTerm(word.word)
    const taggedWord = { normalized, tag: word.tag }
    if (!isCjkPhraseWord(taggedWord)) {
      if (current.length > 0) {
        groups.push(current)
        current = []
      }
      continue
    }

    current.push(taggedWord)
  }

  if (current.length > 0) {
    groups.push(current)
  }

  return groups
}

function isCjkPhraseWord(word: TaggedWord): boolean {
  if (!isPureCjkTerm(word.normalized) || word.normalized.length < 2) {
    return false
  }

  return word.tag.startsWith('n') || word.tag === 'v'
}

function isCjkPhrasePair(left: TaggedWord, right: TaggedWord): boolean {
  const leftIsNoun = left.tag.startsWith('n')
  const rightIsNoun = right.tag.startsWith('n')

  return (leftIsNoun && rightIsNoun) || (left.tag === 'v' && rightIsNoun)
}

function addCjkPhraseTermCandidates(
  phrases: string[],
  candidates: Map<string, NovelTermCandidate>,
  orderRef: { value: number }
): void {
  for (const phrase of phrases) {
    addNovelTermCandidate(candidates, phrase, CJK_BIGRAM_TERM_SCORE, orderRef)
  }
}

function addEnglishPhraseTermCandidates(
  words: string[],
  candidates: Map<string, NovelTermCandidate>,
  orderRef: { value: number }
): void {
  for (let index = 0; index < words.length - 1; index += 1) {
    const left = words[index]
    const right = words[index + 1]
    if (!left || !right) {
      continue
    }

    addNovelTermCandidate(candidates, `${left} ${right}`, PHRASE_TERM_SCORE, orderRef)
  }
}

function extractEnglishNounPhraseGroups(value: string): string[][] {
  return nlp(value)
    .nouns()
    .out('array')
    .map((phrase) =>
      stopword
        .removeStopwords(phrase.split(/\s+/u).map(normalizeNovelTerm), stopword.eng)
        .filter(isPhraseWord)
    )
    .filter((words) => words.length >= 2)
}

function extractCjkPhrases(value: string): string[] {
  const phrases: string[] = []

  for (const group of segmentCjkWordGroups(value)) {
    const indexes =
      group.length > 2
        ? [
            ...Array.from({ length: Math.floor(group.length / 2) }, (_, index) => index * 2),
            ...(group.length % 2 === 1 ? [group.length - 2] : [])
          ]
        : Array.from({ length: Math.max(0, group.length - 1) }, (_, index) => index)

    for (const index of indexes) {
      const left = group[index]
      const right = group[index + 1]
      if (!left || !right || !isCjkPhrasePair(left, right)) {
        continue
      }

      phrases.push(`${left.normalized}${right.normalized}`)
    }
  }

  return phrases
}

function extractSegmentedTermCandidates(
  value: string,
  candidates: Map<string, NovelTermCandidate>,
  orderRef: { value: number }
): void {
  for (const fragment of value.split(STRUCTURAL_SPLIT_PATTERN)) {
    if (CJK_PATTERN.test(fragment)) {
      addCjkPhraseTermCandidates(extractCjkPhrases(fragment), candidates, orderRef)
      continue
    }

    for (const group of extractEnglishNounPhraseGroups(fragment)) {
      addEnglishPhraseTermCandidates(group, candidates, orderRef)
    }
  }
}

function extractNovelTermCandidates(value: string): NovelTermCandidate[] {
  if (!normalizeText(value)) {
    return []
  }

  const candidates = new Map<string, NovelTermCandidate>()
  const orderRef = { value: 0 }

  extractMarkedTermCandidates(value, candidates, orderRef)
  extractSyntaxTermCandidates(value, candidates, orderRef)
  extractSegmentedTermCandidates(value, candidates, orderRef)

  return [...candidates.values()]
    .filter((candidate) => candidate.score >= MIN_EXTRACTABLE_TERM_SCORE)
    .sort((left, right) => right.score - left.score || left.order - right.order)
}

function filterOverlappingTerms<T extends NovelTermCandidate>(terms: T[]): T[] {
  const kept: T[] = []

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

function buildContextTermStats(documents: string[]): {
  documentFrequency: Map<string, number>
  terms: Set<string>
} {
  const documentFrequency = new Map<string, number>()
  const terms = new Set<string>()

  for (const document of documents) {
    const documentTerms = new Set(
      extractNovelTermCandidates(document).map((candidate) => candidate.normalized)
    )

    for (const term of documentTerms) {
      terms.add(term)
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }

  return { documentFrequency, terms }
}

function isKnownContextTerm(term: string, contextTerms: Set<string>): boolean {
  if (contextTerms.has(term)) {
    return true
  }

  for (const contextTerm of contextTerms) {
    if (contextTerm.length > term.length && contextTerm.includes(term)) {
      return true
    }
  }

  return false
}

function scoreNovelTerm(input: {
  candidate: NovelTermCandidate
  contextDocumentCount: number
  documentFrequency: number
}): number {
  const idf = Math.log((input.contextDocumentCount + 1) / (input.documentFrequency + 1)) + 1
  const tfBoost = 1 + Math.log1p(Math.max(0, input.candidate.count - 1)) * 0.25
  return Math.min(1, input.candidate.score * idf * tfBoost)
}

function combineNoveltyScore(
  terms: Array<NovelTermCandidate & { noveltyStrength: number }>
): number {
  const unseenProbability = terms
    .slice(0, 4)
    .reduce((remaining, candidate) => remaining * (1 - candidate.noveltyStrength), 1)
  return Number((1 - unseenProbability).toFixed(3))
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
  const contextStats = buildContextTermStats(contextWindow)
  const queryTerms = extractNovelTermCandidates(input.userQuery)

  if (queryTerms.length === 0) {
    return { noveltyScore: 0, novelTerms: [] }
  }

  const novelTerms = filterOverlappingTerms(
    queryTerms
      .filter((term) => !isKnownContextTerm(term.normalized, contextStats.terms))
      .map((candidate) => ({
        ...candidate,
        noveltyStrength: scoreNovelTerm({
          candidate,
          contextDocumentCount: contextWindow.length,
          documentFrequency: contextStats.documentFrequency.get(candidate.normalized) ?? 0
        })
      }))
      .filter((candidate) => candidate.noveltyStrength >= MIN_NOVEL_TERM_STRENGTH)
      .sort(
        (left, right) =>
          right.noveltyStrength - left.noveltyStrength ||
          right.score - left.score ||
          left.order - right.order
      )
  ).slice(0, MAX_NOVEL_TERMS)
  const noveltyScore = combineNoveltyScore(novelTerms)

  if (noveltyScore < NOVELTY_SCORE_THRESHOLD) {
    return { noveltyScore: 0, novelTerms: [] }
  }

  return {
    noveltyScore,
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

function hasEnoughNoveltyEvidence(novelty: RecallNoveltySignal): boolean {
  return novelty.novelTerms.length >= NOVELTY_TERM_THRESHOLD
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

  const hasTopicNovelty =
    novelty.noveltyScore >= NOVELTY_SCORE_THRESHOLD && hasEnoughNoveltyEvidence(novelty)

  if (hasTopicNovelty) {
    reasons.push('topic-novelty')
    score = novelty.noveltyScore
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
