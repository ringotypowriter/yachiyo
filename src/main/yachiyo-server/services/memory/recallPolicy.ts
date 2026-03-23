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
const GROWTH_CHAR_THRESHOLD = 900
const IDLE_RECALL_MS = 1000 * 60 * 60 * 6
const RECENT_INJECTION_MESSAGE_WINDOW = 4
const RECENT_INJECTION_CHAR_WINDOW = 900
const RECENT_INJECTION_SCORE_BOOST = 0.22
const MAX_RECENT_INJECTIONS = 16
const MAX_NOVEL_TERMS = 6
const RECENT_CONTEXT_MESSAGE_LIMIT = 6
const CJK_SEGMENT_PATTERN = /[\u3400-\u9fff]+/gu
const LATIN_TERM_PATTERN = /[A-Za-z][A-Za-z0-9._:/-]*/gu

const CHINESE_STOPWORDS = new Set([
  '这个',
  '那个',
  '这样',
  '那样',
  '一下',
  '一个',
  '一些',
  '已经',
  '现在',
  '还是',
  '就是',
  '然后',
  '如果',
  '因为',
  '所以',
  '我们',
  '你们',
  '他们',
  '还有',
  '另外',
  '顺便',
  '换个',
  '问题',
  '这里',
  '这个问题',
  '那个问题',
  '需要',
  '可以',
  '怎么',
  '怎样',
  '是否',
  '一下子'
])

const ENGLISH_STOPWORDS = new Set([
  'ok',
  'okay',
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'about',
  'there',
  'their',
  'have',
  'should',
  'would',
  'could',
  'what',
  'when',
  'where',
  'which',
  'while',
  'also',
  'just',
  'another',
  'question',
  'issue',
  'problem',
  'please',
  'help',
  'continue'
])

const TOPIC_SHIFT_CUES = [
  '另外',
  '顺便',
  '回头说',
  '换个问题',
  '还有一个',
  '另一个',
  '换个话题',
  'by the way',
  'another question',
  'switching gears',
  'separately',
  'also'
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

function extractCjkTerms(value: string): string[] {
  const terms: string[] = []

  for (const segment of value.match(CJK_SEGMENT_PATTERN) ?? []) {
    if (segment.length < 2) {
      continue
    }

    if (segment.length <= 6 && !CHINESE_STOPWORDS.has(segment)) {
      terms.push(segment)
    }

    for (let size = 2; size <= 3; size += 1) {
      if (segment.length < size) {
        continue
      }

      for (let index = 0; index <= segment.length - size; index += 1) {
        const token = segment.slice(index, index + size)
        if (!CHINESE_STOPWORDS.has(token)) {
          terms.push(token)
        }
      }
    }
  }

  return terms
}

function extractLatinTerms(value: string): string[] {
  return (value.match(LATIN_TERM_PATTERN) ?? [])
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 2 && !ENGLISH_STOPWORDS.has(term))
}

function uniqueTerms(value: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []

  for (const term of [...extractCjkTerms(value), ...extractLatinTerms(value)]) {
    if (seen.has(term)) {
      continue
    }

    seen.add(term)
    terms.push(term)
  }

  return terms
}

function scoreTerm(term: string): number {
  const latinBoost = /[a-z]/u.test(term) ? 3 : 0
  const shortPenalty = term.length <= 2 ? 0.5 : 0
  return term.length + latinBoost - shortPenalty
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

  const novelTerms = queryTerms
    .filter((term) => !contextTerms.has(term))
    .sort((left, right) => scoreTerm(right) - scoreTerm(left))
    .slice(0, MAX_NOVEL_TERMS)
  const topicShiftBoost = TOPIC_SHIFT_CUES.some((cue) => normalizedQuery.includes(cue)) ? 0.2 : 0
  const noveltyScore = Math.min(
    1,
    novelTerms.length / Math.max(2, Math.min(queryTerms.length, 6)) + topicShiftBoost
  )

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
  const novelty = detectNoveltySignal({
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
