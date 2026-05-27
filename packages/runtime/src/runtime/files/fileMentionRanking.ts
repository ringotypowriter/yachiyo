import { basename } from 'node:path'
import { matchSorter } from 'match-sorter'
import { normalizeRelativePath, toUnique } from './fileMentionPathUtils.ts'

export function scoreFuzzySubstring(query: string, target: string): number | null {
  const exactIndex = target.indexOf(query)
  if (exactIndex >= 0) {
    return 9_000 - exactIndex * 40 - (target.length - query.length)
  }

  const positions: number[] = []
  let searchIndex = 0
  for (const char of query) {
    const foundIndex = target.indexOf(char, searchIndex)
    if (foundIndex < 0) {
      return null
    }
    positions.push(foundIndex)
    searchIndex = foundIndex + 1
  }

  const start = positions[0] ?? 0
  const end = positions[positions.length - 1] ?? start
  const span = end - start + 1
  let consecutiveMatches = 0
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] === positions[index - 1] + 1) {
      consecutiveMatches += 1
    }
  }

  return (
    6_000 -
    start * 30 -
    (span - query.length) * 20 -
    (target.length - query.length) * 3 +
    consecutiveMatches * 35
  )
}

function scoreFuzzySegments(query: string, candidatePath: string): number | null {
  const querySegments = query.split('/').filter(Boolean)
  if (querySegments.length < 2) {
    return null
  }

  const candidateSegments = candidatePath.split('/')
  let nextCandidateIndex = 0
  let totalScore = 0
  let firstMatchIndex = -1
  let lastMatchIndex = -1

  for (const querySegment of querySegments) {
    let bestIndex = -1
    let bestScore = Number.NEGATIVE_INFINITY
    for (let index = nextCandidateIndex; index < candidateSegments.length; index += 1) {
      const segmentScore = scoreFuzzySubstring(querySegment, candidateSegments[index])
      if (segmentScore === null || segmentScore <= bestScore) {
        continue
      }

      bestIndex = index
      bestScore = segmentScore
    }

    if (bestIndex < 0) {
      return null
    }

    if (firstMatchIndex < 0) {
      firstMatchIndex = bestIndex
    }
    lastMatchIndex = bestIndex
    totalScore += bestScore
    nextCandidateIndex = bestIndex + 1
  }

  const skippedSegments =
    firstMatchIndex >= 0 && lastMatchIndex >= 0
      ? lastMatchIndex - firstMatchIndex + 1 - querySegments.length
      : 0

  return totalScore + 2_500 - firstMatchIndex * 80 - skippedSegments * 120
}

function scoreTightFuzzySegment(query: string, target: string): number | null {
  if (!query) {
    return null
  }

  if (target === query) {
    return 24_000 - target.length
  }

  if (target.startsWith(query)) {
    return 20_000 - (target.length - query.length) * 40
  }

  const substringIndex = target.indexOf(query)
  if (substringIndex >= 0) {
    return 16_000 - substringIndex * 140 - (target.length - query.length) * 20
  }

  const positions: number[] = []
  let searchIndex = 0
  for (const char of query) {
    const foundIndex = target.indexOf(char, searchIndex)
    if (foundIndex < 0) {
      return null
    }

    positions.push(foundIndex)
    searchIndex = foundIndex + 1
  }

  const start = positions[0] ?? 0
  const end = positions[positions.length - 1] ?? start
  const extraSpan = end - start + 1 - query.length
  const allowedExtraSpan = Math.max(1, Math.floor(query.length / 3))
  if (start > 0 || extraSpan > allowedExtraSpan) {
    return null
  }

  let consecutiveMatches = 0
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] === positions[index - 1] + 1) {
      consecutiveMatches += 1
    }
  }

  return 12_000 - extraSpan * 80 - (target.length - query.length) * 6 + consecutiveMatches * 30
}

function scoreStructuredPathQuery(query: string, candidatePath: string): number | null {
  const querySegments = query.split('/').filter(Boolean)
  if (querySegments.length < 2) {
    return null
  }

  const candidateSegments = candidatePath.split('/').filter(Boolean)
  if (candidateSegments.length < querySegments.length) {
    return null
  }

  let bestScore: number | null = null
  const lastStartIndex = candidateSegments.length - querySegments.length
  for (let startIndex = 0; startIndex <= lastStartIndex; startIndex += 1) {
    let totalScore = 0
    let matched = true

    for (let index = 0; index < querySegments.length; index += 1) {
      const segmentScore = scoreTightFuzzySegment(
        querySegments[index],
        candidateSegments[startIndex + index]
      )
      if (segmentScore === null) {
        matched = false
        break
      }

      totalScore += segmentScore
    }

    if (!matched) {
      continue
    }

    const score =
      totalScore +
      30_000 -
      startIndex * 200 -
      (candidateSegments.length - querySegments.length - startIndex) * 120

    if (bestScore === null || score > bestScore) {
      bestScore = score
    }
  }

  return bestScore
}

export function scoreWorkspaceFileMentionCandidate(
  query: string,
  candidatePath: string
): number | null {
  const normalizedQuery = normalizeRelativePath(query.trim()).toLowerCase()
  const normalizedCandidate = normalizeRelativePath(candidatePath).toLowerCase()

  if (!normalizedQuery) {
    return 0
  }

  if (normalizedCandidate === normalizedQuery) {
    return 100_000 - normalizedCandidate.length
  }

  if (normalizedQuery.includes('/')) {
    const pathScores = [
      scoreStructuredPathQuery(normalizedQuery, normalizedCandidate),
      scoreFuzzySegments(normalizedQuery, normalizedCandidate)
    ].filter((value): value is number => value !== null)

    if (pathScores.length === 0) {
      return null
    }

    return Math.max(...pathScores)
  }

  const basenameScore = scoreFuzzySubstring(
    basename(normalizedQuery),
    basename(normalizedCandidate)
  )
  const pathScore = scoreFuzzySubstring(normalizedQuery, normalizedCandidate)
  const segmentScore = scoreFuzzySegments(normalizedQuery, normalizedCandidate)
  const scores = [
    basenameScore === null ? null : basenameScore + 2_000,
    pathScore,
    segmentScore
  ].filter((value): value is number => value !== null)

  if (scores.length === 0) {
    return null
  }

  return Math.max(...scores)
}

export function rankWorkspaceFileMentionCandidates(
  query: string,
  candidatePaths: string[],
  limit: number
): string[] {
  if (!query.trim()) {
    return candidatePaths.slice(0, limit)
  }

  const normalizedQuery = normalizeRelativePath(query.trim()).toLowerCase()
  const matcherQuery = normalizedQuery.includes('/')
    ? normalizeFileMentionMatcherValue(normalizedQuery)
    : normalizedQuery

  return matchSorter(toUnique(candidatePaths), matcherQuery, {
    keys: normalizedQuery.includes('/')
      ? [
          (candidatePath) => normalizeFileMentionMatcherValue(candidatePath),
          (candidatePath) => candidatePath
        ]
      : [
          (candidatePath) => basename(candidatePath),
          (candidatePath) => normalizeFileMentionMatcherValue(basename(candidatePath)),
          (candidatePath) => candidatePath,
          (candidatePath) => normalizeFileMentionMatcherValue(candidatePath)
        ],
    baseSort: (left, right) =>
      left.item.length - right.item.length || left.item.localeCompare(right.item)
  }).slice(0, limit)
}

function normalizeFileMentionMatcherValue(value: string): string {
  return normalizeRelativePath(value)
    .toLowerCase()
    .replace(/[./_-]+/g, ' ')
}
