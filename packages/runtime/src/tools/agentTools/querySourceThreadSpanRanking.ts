import type { MessageRecord, ThreadRecord } from '@yachiyo/shared/protocol'

export interface ThreadSpanRankingCandidate<Row> {
  bm25: number
  messages: MessageRecord[]
  ordinal: number
  row: Row
  searchText: string
}

function includesText(value: string | undefined, text: string): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(text.toLowerCase())
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)]
}

function countTermOccurrences(value: string, term: string): number {
  const lowerValue = value.toLowerCase()
  const lowerTerm = term.toLowerCase()
  if (lowerTerm.length === 0) {
    return 0
  }

  let count = 0
  let index = lowerValue.indexOf(lowerTerm)
  while (index >= 0) {
    count += 1
    index = lowerValue.indexOf(lowerTerm, index + lowerTerm.length)
  }
  return count
}

export function tokenizeQuery(query: string): string[] {
  return (
    query
      .replace(/\s+/gu, ' ')
      .trim()
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter(Boolean)
}

export function buildSpanSearchText(input: {
  matchedEvidence: string[]
  messages: MessageRecord[]
  thread: ThreadRecord
}): string {
  return [
    input.thread.title,
    input.thread.preview,
    ...input.matchedEvidence,
    ...input.messages.map((message) => message.content)
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
}

function createIdfByTerm(terms: string[], documents: string[]): Map<string, number> {
  const idfByTerm = new Map<string, number>()
  for (const term of terms) {
    const documentFrequency = documents.filter((document) => includesText(document, term)).length
    idfByTerm.set(term, Math.log((documents.length + 1) / (documentFrequency + 1)) + 1)
  }
  return idfByTerm
}

function calculateCoverage(input: {
  idfByTerm: Map<string, number>
  searchText: string
  terms: string[]
}): number {
  const totalWeight = input.terms.reduce((sum, term) => sum + (input.idfByTerm.get(term) ?? 0), 0)
  if (totalWeight === 0) {
    return 0
  }

  const coveredWeight = input.terms.reduce(
    (sum, term) =>
      includesText(input.searchText, term) ? sum + (input.idfByTerm.get(term) ?? 0) : sum,
    0
  )
  return coveredWeight / totalWeight
}

function calculateDensity(input: {
  idfByTerm: Map<string, number>
  messages: MessageRecord[]
  terms: string[]
}): number {
  const content = input.messages.map((message) => message.content).join('\n')
  const weightedOccurrenceCount = input.terms.reduce(
    (sum, term) => sum + countTermOccurrences(content, term) * (input.idfByTerm.get(term) ?? 0),
    0
  )
  return weightedOccurrenceCount / Math.max(1, input.messages.length)
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value))
}

function sigmoidNormalizeHigher(values: number[]): number[] {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const standardDeviation = Math.sqrt(variance)
  if (standardDeviation === 0) {
    return values.map(() => 0.5)
  }
  return values.map((value) => sigmoid((value - mean) / standardDeviation))
}

function sigmoidNormalizeLower(values: number[]): number[] {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const standardDeviation = Math.sqrt(variance)
  if (standardDeviation === 0) {
    return values.map(() => 0.5)
  }
  return values.map((value) => sigmoid((mean - value) / standardDeviation))
}

export function rankThreadSpanCandidates<Row>(
  candidates: Array<ThreadSpanRankingCandidate<Row>>,
  queryTerms: string[]
): Row[] {
  if (candidates.length === 0) {
    return []
  }
  const terms = uniqueValues(queryTerms)
  if (terms.length === 0) {
    return candidates.map((candidate) => candidate.row)
  }

  const idfByTerm = createIdfByTerm(
    terms,
    candidates.map((candidate) => candidate.searchText)
  )
  const bm25Scores = sigmoidNormalizeLower(candidates.map((candidate) => candidate.bm25))
  const coverageScores = sigmoidNormalizeHigher(
    candidates.map((candidate) =>
      calculateCoverage({
        idfByTerm,
        searchText: candidate.searchText,
        terms
      })
    )
  )
  const densityScores = sigmoidNormalizeHigher(
    candidates.map((candidate) =>
      calculateDensity({
        idfByTerm,
        messages: candidate.messages,
        terms
      })
    )
  )

  return candidates
    .map((candidate, index) => ({
      candidate,
      score: bm25Scores[index]! + coverageScores[index]! + densityScores[index]!
    }))
    .sort(
      (left, right) => right.score - left.score || left.candidate.ordinal - right.candidate.ordinal
    )
    .map(({ candidate }) => candidate.row)
}
