// Scoring helper for slash-command / skill / file-mention completion.
// Higher score = better match. Returns null for no match.
//
// Tiers (roughly):
//   100 exact (case-insensitive)
//    80 prefix
//    60 word-boundary substring (after /, :, -, _, ., space)
//    40 plain substring
//    20 subsequence (fuzzy)
// Ties are broken by shorter candidate first, then original order — callers
// should pass the original index via `scoreCandidates` to get a stable sort.

const WORD_BOUNDARY = /[/:\-_. ]/

export function scoreMatch(candidate: string, query: string): number | null {
  if (query.length === 0) return 50
  const c = candidate.toLowerCase()
  const q = query.toLowerCase()
  if (c === q) return 100
  if (c.startsWith(q)) return 80 - Math.min(candidate.length - query.length, 20) * 0.1
  const idx = c.indexOf(q)
  if (idx >= 0) {
    const boundary = idx === 0 || WORD_BOUNDARY.test(c[idx - 1])
    return (boundary ? 60 : 40) - idx * 0.1
  }
  // subsequence
  let ci = 0
  let qi = 0
  while (ci < c.length && qi < q.length) {
    if (c[ci] === q[qi]) qi++
    ci++
  }
  if (qi === q.length) return 20 - (c.length - q.length) * 0.05
  return null
}

export interface ScoredCandidate<T> {
  item: T
  score: number
  index: number
}

export function scoreCandidates<T>(
  items: T[],
  query: string,
  fields: (item: T) => string[]
): ScoredCandidate<T>[] {
  const out: ScoredCandidate<T>[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const strs = fields(item)
    let best: number | null = null
    for (let f = 0; f < strs.length; f++) {
      const s = scoreMatch(strs[f], query)
      if (s === null) continue
      // Prefer earlier fields slightly.
      const weighted = s - f * 1.5
      if (best === null || weighted > best) best = weighted
    }
    if (best !== null) out.push({ item, score: best, index: i })
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.index - b.index
  })
  return out
}
