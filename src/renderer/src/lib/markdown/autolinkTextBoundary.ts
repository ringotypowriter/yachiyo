const AUTOLINK_CANDIDATE_PATTERN = String.raw`https?:\/\/[^\s<>'")\]]+`
const AUTOLINK_CANDIDATE_RE = new RegExp(`^${AUTOLINK_CANDIDATE_PATTERN}$`)
const URL_TEXT_BOUNDARY_RE = /[\x80-\uFFFF]/
const HTTP_SCHEME_RE = /^https?:\/\//

export interface AutolinkCandidateSplit {
  url: string
  trailingText: string
}

export function findAutolinkCandidates(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(new RegExp(AUTOLINK_CANDIDATE_PATTERN, 'g'))
}

export function splitAutolinkCandidate(candidate: string): AutolinkCandidateSplit | null {
  if (!AUTOLINK_CANDIDATE_RE.test(candidate)) return null

  const boundaryIndex = candidate.search(URL_TEXT_BOUNDARY_RE)
  const url = boundaryIndex === -1 ? candidate : candidate.slice(0, boundaryIndex)

  if (!HTTP_SCHEME_RE.test(url)) return null
  const schemeEnd = url.indexOf('//') + 2
  if (url.length <= schemeEnd) return null

  return {
    url,
    trailingText: boundaryIndex === -1 ? '' : candidate.slice(boundaryIndex)
  }
}
